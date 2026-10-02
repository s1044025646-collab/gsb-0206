# 量子线路状态向量与测量分支模拟后端

一个**纯本地、离线**的小规模量子线路模拟器，只提供 API 与 CLI（无前端、不连接任何量子硬件）。
使用 TypeScript + Node.js 内置 `node:sqlite` 持久化，零原生编译依赖，不需要 Docker、WSL、付费服务或外部在线 API。

## 功能

- 自行实现状态向量演化（稠密振幅数组），**未调用任何现成量子线路模拟器**。
- 支持门：`H X Y Z S T`（相位）、`P(θ)`、`RX(θ) RY(θ) RZ(θ)`（绕轴旋转）、`CNOT`（受控 X，支持多控制位）。
- 复数用显式结构 `{ "re": number, "im": number }` 表示。
- 初态校验：维度必须为 `2^n`、范数归一（偏差阈值 `1e-6`），门参数 / 控制位 / 目标位合法。
- 记录每步**态范数与数值误差**；区分整体相位与相对相位：仅差整体相位的两个态判为**物理等价**，但不视为逐分量相同。
- 基态概率查询、指定 Pauli 串期望值（返回按基矢的逐项计算依据）。
- 中途测量、坍缩、**测量结果驱动的经典控制后续门**、指定结果的**后选择**（零概率后选择被拒绝并说明原因）。
- 精确分支枚举（权重沿测量树**逐级相乘**）与固定种子的多次抽样（每条轨迹沿坍缩后的分支继续，绝不逐量子位独立抽取边缘分布）。
- 公开分支数 / 步数 / 内存预算；达到上限时返回 `truncated=true` 与原因，**不丢弃低概率分支冒充精确结果**。
- 线路导入、逐步执行、精确测量树、抽样统计、期望值、态比较、JSON/CSV 导出。
- SQLite 保存线路（**按名称版本化**，编辑产生新版本）、种子与算法配置、**不可变结果快照**；旧报告永不被后续编辑改写。
- 量子传态演示：多个不同输入态经经典修正后恢复，并在“重启”后从 SQLite 读回原报告。

## 计算基与量子位编号约定

- 量子位编号 `q0 … q(n-1)`，数量 `1 ≤ n ≤ 12`。
- 数组索引的**最低位（LSB）对应 q0**。
- 位串字符串最左字符为**最高位**量子位 `q(n-1)`。
- 例如 `n=2` 时位串 `10` 表示 `q1=1, q0=0`，对应索引 `2`。
- 测量结果串顺序与 `qubits` 数组顺序一致（每位 `0/1`）。

## 环境要求

- Windows 上安装 Node.js **≥ 22.5**（内置 `node:sqlite`；开发使用 v25 验证）。

## 安装与构建

```powershell
npm install
npm run build
```

## 测试

```powershell
npm test
```

覆盖：计算基编号、门与逆门、两次 H 干涉、Bell 态相关测量、中途测量后经典条件修正、不可能的后选择、
独立小规模稠密矩阵乘法逐门核对、精确分支概率和为 1、抽样可复现、仅整体相位等价、Pauli 期望。

## 启动 HTTP 服务

```powershell
# 开发方式（tsx）
npm start
# 或构建产物
npm run start:dist
```

可配置端口与项目内数据目录（均为可选项）：

```powershell
$env:QSIM_PORT="9000"   # 默认 8787（PORT 也可）
$env:QSIM_DATA="E:\myproj\data"   # 默认 ./data
npm start
```

### HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/convention` | 位编号 / 高低位约定与最大量子位数 |
| GET | `/circuits` | 列出已保存线路（含版本） |
| POST | `/circuits` | 导入并版本化保存线路 `{circuit, persist?}` |
| GET | `/circuits/:name` 或 `/circuits/:name/v:version` | 读取线路 |
| POST | `/steps` | 逐步执行（每步范数/误差） |
| POST | `/exact` | 精确测量树（含 CSV 字段） |
| POST | `/sample` | 固定种子抽样 `{circuit, shots, seed}` |
| POST | `/probabilities` | 基态概率（含 CSV） |
| POST | `/expectation` | Pauli 期望 `{circuit, terms:[{qubit,pauli}]}` |
| POST | `/compare` | 态比较 `{circuitA, circuitB}` |
| GET | `/snapshots/:id` | 读取不可变结果快照 |
| GET | `/reports/:name/v:version` | 列出某线路版本的报告 |

示例（PowerShell）：

```powershell
$body = Get-Content examples\bell.json -Raw | ConvertFrom-Json
Invoke-RestMethod http://localhost:8787/exact -Method Post -ContentType 'application/json' `
  -Body (@{ circuit = $body } | ConvertTo-Json -Depth 8)
```

## CLI

```powershell
npx tsx src/cli.ts convention
npx tsx src/cli.ts import examples/bell.json --name bell
npx tsx src/cli.ts steps examples/bell.json
npx tsx src/cli.ts exact examples/bell.json --csv
npx tsx src/cli.ts sample examples/bell.json --shots 500 --seed 42
npx tsx src/cli.ts probabilities examples/bell.json --csv
npx tsx src/cli.ts expectation examples/bell.json --pauli "Z:0,X:1"
npx tsx src/cli.ts circuits
npx tsx src/cli.ts reports bell
npx tsx src/cli.ts report 1
```

构建后亦可：`node dist/src/cli.js exact examples/bell.json --csv`。

## 线路 JSON 结构

```json
{
  "name": "demo",
  "qubits": 2,
  "seed": 42,
  "initial": [ { "re": 1, "im": 0 }, { "re": 0, "im": 0 }, { "re": 0, "im": 0 }, { "re": 0, "im": 0 } ],
  "steps": [
    { "kind": "gate", "gate": "H", "target": 0 },
    { "kind": "gate", "gate": "CNOT", "controls": [0], "target": 1 },
    { "kind": "measure", "qubits": [0, 1], "register": "m", "postselect": "11" },
    { "kind": "gate", "gate": "X", "target": 1, "classicalWhen": { "register": "m", "equals": "10" } }
  ]
}
```

- `initial` 省略时默认 `|0…0>`。
- `measure.qubits` 省略表示测量全部量子位。
- `postselect` 位串顺序与 `qubits` 一致。
- `classicalWhen` 实现测量结果控制的后续门：仅当命名经典寄存器等于给定串时执行。

## 演示（量子传态 + 重启读报告）

```powershell
npm run demo
```

会对 `|0>`、`|1>`、`|+>`、`0.6|0>+0.8i|1>` 四个输入态执行完整传态，验证 Bob 量子位恢复概率，
并演示固定种子抽样可复现，随后以**新的服务实例**从 SQLite 读回此前的结果快照。

## 预算与限制

- 最多 12 量子位（状态向量长度 ≤ 4096）。
- 默认：分支上限 `100000`、步数上限 `10000`、单状态向量内存估计上限 64 MiB、容差 `1e-9`（见 `src/core/types.ts`）。
- 测量分支随测量数指数增长，大量中途测量会更快触及分支预算（此时结果标记为未完成）。
- 数值为双精度浮点；`node:sqlite` 在当前 Node 版本会打印实验性警告，功能不受影响。
