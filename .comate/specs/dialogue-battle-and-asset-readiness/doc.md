# 对话战斗提示词与素材完成度校正

## 需求场景与处理逻辑

当前反馈包含两个需要同时处理但不能混淆的目标：

1. Wan3 提示词中必须真实包含对话和战斗情节，不能只依赖普通分镜字段或人工后处理。
2. 必须确认当前数据格式和图片生成状态，只有所有实际出片依赖存在且格式有效时，才能判定“图片都生成完”。

当前核查结论：

- 《人间渡》`ep01` 有 7 个镜段，当前已有 `wan3Prompt` 的 7 个值中确实包含部分对白和动作，但这不是通用分镜流程自动生成的结果。
- 通用 `generateStoryboard()` 只生成 `action`、`lines`、`sfx`、`motionPrompt`、`imagePrompt` 等标准字段，没有编译 `wan3Prompt` 的步骤。
- `Shot` schema 未声明 `wan3Prompt`、`wan3Mode`、`firstFramePath`、`lastFramePath` 等 Wan3 扩展字段；`create.ts` 复用已有剧本时通过 `Shot.parse()` 会剥离这些未知字段，后续可能造成对白、动作和生成模式丢失。
- 《人间渡》`ep01/media/images` 中有 17 张有效 PNG 静态资产，但脚本声明的 7 张 Wan3 首帧全部缺失，首帧完成度为 `0/7`，不能确认“图片都生成完”。
- 分镜表还明确存在 S3 缺少漏风书房场景卡、S4 缺少妇人角色参考图的问题。

处理策略：

- 扩展 `Shot` 数据契约，使 Wan3 字段在解析、复用和导出链路中不会被删除。
- 增加确定性的 Wan3 prompt 编译函数：从 `action`、`motionPrompt`、`lines`、`sfx`、镜头尺寸、景别、视角、机位、焦段、运镜、节奏和时长拼出完整提示词；对白必须保留说话角色和原文，战斗/冲突动作必须保留动作顺序、接触关系、结果和状态变化。
- 用户提供的高质量提示词样例确定了最终格式：先写“首帧”或“首帧/尾帧”锁定的构图、空间关系、人物姿态、道具形态、比例和全片生效约束；再写各角色/场景/道具参考图的 `@图片` 锚点及其锁定内容；随后写“生成单镜头。无台词/对白内容。”、“镜头参数：……”和“画面内容：……”；最后写明确的“结束状态”。
- 默认不写“第几秒到第几秒”。动作按连续因果链描述：承接前序状态、触发动作、运动轨迹、接触/受力、人物反应、环境保持不变、结束状态。只有用户明确要求固定节拍、音画同步或必须在特定时刻发生的转场，才加入时间点。
- 提示词不使用空泛的“发生战斗/人物受伤/镜头推进”等概括语，要写清楚对象、方向、速度、接触位置、比例、状态变化和不应改变的背景条件。
- 样例的稳定性主要来自素材锚点和关系约束：首帧/尾帧引用、角色身份与外形、道具或结构的空间关系、动作顺序、接触和受力结果、镜头参数。提示词编译器应优先生成这些约束，不以秒级文本长度作为质量保证。
- 当 prompt 提到具体人物、场景或道具时，必须在 prompt 中写出对应图片引用，例如 `@阿离-正面.png`、`@状元桥街市.png`，并在实际视频请求中按同一顺序上传这些图片。引用名不能只存在于文本而不进入 API 请求。
- 每个镜段的引用清单应由角色、场景、道具和显式 `wan3ReferencePaths` 共同构建，并在接口响应中保留顺序、用途和文件状态，供前端核对“文字引用”和“实际上传图片”是否一致。
- 当前 `/api/produce` 将 `first_frame` 与 `reference_image` 视为互斥。需要参考图的镜段不能继续伪装成只使用首帧的模式：要么切换到 `reference` 模式并上传引用图，要么明确只使用首帧并不在 prompt 中写参考图上传承诺。
- 用户提供高质量提示词样例后，以样例作为镜头参数组织和表达格式的参考，提取可复用的结构，不直接复制其中的具体人物、剧情或素材内容。
- 对已有明确 `wan3Prompt` 的数据保持兼容，不无故覆盖人工定稿；对没有 Wan3 prompt 的新分镜自动生成。
- 增加素材就绪核验，按脚本实际声明的 `firstFramePath`、`lastFramePath`、`wan3ReferencePaths` 和必要视觉资产检查存在性及图片格式。静态资产数量不能替代镜段首帧依赖数量。
- 增加资产内容正确性校验：不能只检查文件存在或 PNG 可解析，还要核对文件名、角色/场景身份、姿态视角和图片实际内容是否一致。用户指出 `阿离-正面.png` 实际展示为侧面+背面，因此应标记为命名或资产内容不一致，不能直接作为“正面”参考图使用。
- 资产校验结果需要支持“有效”“格式有效但内容/命名不一致”“缺失”三种状态，并在控制台显示具体原因；内容不一致的角色图不得计入对应姿态的 ready 统计。
- 只有关键帧和 API 参考图全部存在、图片可解析、字段格式满足接口约束时，才返回或显示“已完成”；否则明确列出缺失项。

## 架构与技术方案

### 提示词数据流

```text
LLM 分镜输出
  -> Shot 标准字段：action / motionPrompt / lines / sfx / cameraMove / shotSize
  -> Wan3 prompt 编译器
  -> script.json.shots[].wan3Prompt
  -> /api/produce 读取并原样提交万相
```

### Wan3 prompt 编译规则

在 `src/core/pipeline/storyboard.ts` 或相邻的现有 pipeline 模块中增加小型纯函数，优先复用现有项目的文本拼接风格，不引入新的模型调用：

```ts
function buildWan3Prompt(shot: Shot): string {
  const dialogue = shot.lines
    .map((line) => `${line.characterName ?? line.characterId}：「${line.text}」`)
    .join('\n');

  return [
    `生成单镜头，时长 ${shot.durationSec} 秒。`,
    shot.action && `动作：${shot.action}`,
    shot.motionPrompt && `运动：${shot.motionPrompt}`,
    dialogue && `对白：${dialogue}`,
    shot.sfx && `音效：${shot.sfx}`,
    shot.cameraMove && `运镜：${shot.cameraMove}`,
  ].filter(Boolean).join('\n');
}
```

实际实现必须根据当前 `Line` 类型字段名调整，不能假定 `characterName` 一定存在。若 `lines` 已经是带角色名的结构，应保留角色名和台词原文；若只有 `characterId`，应通过现有角色表解析名称。

对战斗或冲突场景，编译器不应改写成抽象的“发生战斗”。应完整保留已有动作文本，并在必要时将动作字段、运动字段按顺序合并。例如：

```text
动作：闻笙抬腕格挡，铃身擦过鬼爪；鬼爪被震开，后退三步，墙面留下裂痕；闻笙保持站立，右臂下垂。
```

不得让对白被 `sfx`、运镜或负面提示词覆盖，也不得仅因为某个镜段没有对白就添加虚构台词。

### Schema 兼容

在 `src/core/schema.ts` 的 `Shot` schema 中声明当前代码实际使用的 Wan3 字段，并与 `/api/produce`、`/api/segments` 的读取类型一致。至少覆盖：

- `wan3Prompt`
- `wan3Mode`
- `firstFramePath`
- `lastFramePath`
- `wan3ReferencePaths`
- 当前脚本实际存在且会传递的音频/继承字段

字段是否必填必须符合现有历史数据：已有普通分镜不能因为缺少 Wan3 扩展字段而解析失败，因此应使用可选字段和合理的枚举/数组约束。

### 素材完成度核验

核验应区分三层：

1. 静态素材：角色卡、场景卡、道具卡，统计存在且能解析的图片。
2. 镜段关键帧：每个镜段实际声明的 `firstFramePath`、`lastFramePath`，按模式判断必需项。
3. Wan3 API 参考图：`wan3ReferencePaths` 中声明的每个文件。

输出至少包含：

```text
静态素材：有效数 / 声明或扫描总数
关键帧：存在数 / 必需数
API 参考图：存在数 / 声明数
缺失文件：绝对路径或可定位的相对路径
图片格式：解析成功数 / 检查数
总体状态：ready | incomplete
```

对于当前 `first_frame` 模式，7 张首帧全部存在才可判定关键帧 ready。17 张静态 PNG 有效只能说明静态素材健康，不能推导首帧 ready。

## 受影响文件

- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/core/schema.ts`
  - 扩展 Shot schema，防止 Wan3 字段被 `Shot.parse()` 丢弃。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/core/pipeline/storyboard.ts`
  - 增加标准分镜到 Wan3 prompt 的确定性编译步骤。
  - 确保 `action`、`lines`、战斗动作、运镜和音效进入 prompt。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/scripts/create.ts`
  - 调整复用/写回逻辑，使 Wan3 字段在已有数据和新生成数据之间正确保留。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/produce/route.ts`
  - 复核 prompt、关键帧和参考图的校验结果；必要时只做格式兼容，不改变 first-frame/reference 互斥规则。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/src/app/api/segments/route.ts`
  - 如需向前端返回完整素材状态，补充缺失清单和总体就绪状态；保留现有 `visual_reference` 展示行为。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/script.json`
  - 仅在编译器和 schema 完成后，通过现有脚本重新生成或补全缺失的 Wan3 prompt；不凭空声明尚未生成的首帧文件。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/storage/works/人间渡/episodes/u1-ep01-02-叶生/ep01/media/images/`
  - 核验现有 PNG；补图属于生成素材操作，不得以静态资产统计冒充已完成。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/dialogue-battle-and-asset-readiness/tasks.md`
  - 后续任务清单。
- `/Users/zhangzhiyu/Desktop/创作/漫剧agent/.comate/specs/dialogue-battle-and-asset-readiness/summary.md`
  - 实施结束后生成。

## 边界条件与异常处理

- 没有对白的镜段不添加虚构对白；有对白时必须保留角色和台词原文。
- 有战斗、冲突、追逐或接触动作时，不能只保留结果描述，必须保留动作顺序和状态变化。
- 已有人工定稿 `wan3Prompt` 时默认保留；只有缺失或明确请求重编译时才自动生成。
- `first_frame` 模式不能因为参考图存在而绕过关键帧缺失校验。
- 参考图展示状态与视频生成就绪状态分开：可展示不等于可出片。
- 非 PNG 图片若项目当前允许 JPG/WebP，应按现有图片代理和 provider 约束判定；不能只依据文件扩展名宣称有效。
- 路径检查必须防止绝对路径被错误拼接成重复工作目录，也不能允许路径逃逸作品目录。
- 不引入字幕处理；对白只作为视频 prompt 和声音描述的一部分。

## 预期结果

- 新生成或重新拆分的镜段，`wan3Prompt` 自动包含已有对白、动作和战斗情节。
- 现有人工定稿 prompt 不会被 `Shot.parse()` 或复用流程无声删除。
- 《人间渡》`ep01` 的真实状态被准确标示为：17 张静态 PNG 有效，但 7 张首帧缺失，整体 `incomplete`，而不是“图片全部生成完”。
- 页面或核验接口能明确显示缺失首帧、缺失场景卡和缺失角色参考图。
- 类型检查、相关数据校验和可用测试通过后，才可确认格式无误。
