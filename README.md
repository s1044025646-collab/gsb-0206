# 量子线路状态向量与测量分支模拟后端

Windows 本地可运行的小规模离线量子线路模拟服务，只提供 **HTTP API 与 CLI**，不连接任何量子硬件或在线服务。使用 TypeScript + Node.js 原生 SQLite（`node:sqlite`），无需 Docker、WSL、付费服务或原生编译工具链。

## 1. 环境与快速开始

要求 Node.js **22.5+**（开发验证版本：Node.js 25.5.0 / npm 11.8.0，Windows）。

```powershell
npm install
npm run build      # 类型检查 + 编译到 dist/
npm test           # 运行 14 项测试（无需先构建）
npm run demo       # 量子传态演示，写入 reports/teleport-report.json
npm start          # 启动 HTTP API，默认 http://localhost:3000
```

CLI 可直接用 TS 源码运行（Node 内置类型擦除）：

```powershell
npm run cli -- validate examples/bell.json
node --experimental-strip-types --no-warnings src/cli/index.ts exact examples/bell-measured.json
```

编译产物入口：`node dist/src/cli/index.js ...`（`tsc` 保留 `src/` 根目录层级）。

## 2. 关键约定（公开且固定）

- 最多 **12 个量子位**，状态向量长度 `2^n`，上限 4096 个振幅。
- 量子位编号 `0..n-1`，**q0 为最高有效位（MSB）**。
- 状态向量下标即计算基整数；下标 `x` 的二进制位满足 `bit(q_k) = (x >> (n-1-k)) & 1`。
  - 例：n=3 时下标 `2 = 010₂` 表示 `|q0=0,q1=1,q2=0>`。
- 复数始终是显式结构 `{ "re": number, "im": number }`，无隐式编码。
- 初态必须维度匹配且归一化；误差超过线路 `tolerance`（默认 `1e-9`）直接拒绝，不会静默重归一。
- 随机性仅来自**固定种子**的确定性 PRNG（mulberry32），不使用真实随机源。

## 3. 支持的门

| 门 | 含义 | 参数 |
|---|---|---|
| `H` | Hadamard | — |
| `X/Y/Z` | Pauli | — |
| `S/T` | 相位门 `P(π/2)` / `P(π/4)` | — |
| `P` | 通用相位门 `diag(1,e^{iφ})` | `angle`（弧度） |
| `RX/RY/RZ` | 绕轴旋转 | `angle`（弧度） |
| `CX` | 受控 X / CNOT | `control`,`target` |

单门支持经典控制条件 `condition: { bit: "a", expected: 1 }`：仅当经典测量寄存器 `a` 为 1 时执行。

状态向量更新为自行实现的成对振幅就地变换（`src/core/statevector.ts`），同时提供**独立稠密矩阵乘法**（`denseApply`/`denseMatrix`）做交叉核对；未调用任何现成量子线路模拟器。

每一步记录门前后范数、偏差与容差（`NormRecord`）。态比较区分：

- **逐分量相同**；
- **仅差整体相位**（`|⟨φ|ψ⟩|=1`）判定物理等价，不视为不同态；
- 相对相位不同则不等价；
- 不用随意重归一掩盖错误门操作。

## 4. 测量、分支与后选择

- **精确测量树**：每个测量按条件概率拆分支，分支权重是沿同一条坍缩路径历次概率的乘积；终态分支为归一化条件态，联合权重和应为 1。
- **固定种子抽样**：同一次 shot 沿坍缩后的同一状态继续，仅用一个随机数对当前条件分布抽样，不会独立抽各量子位边缘而破坏纠缠。
- **后选择**：测量可带 `postselect: 0|1`；零概率后选择被拒绝并返回中文原因。
- **预算**：`maxBranches` / `maxSteps` / `maxBytes`。超限时 `complete=false` 且给出 `reason`，绝不丢弃低概率分支后冒充精确结果。

## 5. 线路 JSON 格式

```json
{
  "name": "bell-measured",
  "qubits": 2,
  "tolerance": 1e-9,
  "steps": [
    { "kind": "gate", "gate": { "type": "H", "target": 0 } },
    { "kind": "gate", "gate": { "type": "CX", "control": 0, "target": 1 } },
    { "kind": "measure", "measurement": { "id": "a", "qubit": 0, "store": "a" } },
    { "kind": "measure", "measurement": { "id": "b", "qubit": 1, "store": "b" } }
  ]
}
```

可选 `initial`：长度 `2^qubits` 的 `{re,im}` 数组，省略表示 `|0…0>`。示例见 `examples/`。

## 6. HTTP API

默认端口可用环境变量 `PORT` 或启动参数配置；数据目录用 `QSIM_DATA`（默认项目内 `./data`）。

```powershell
$env:PORT='3123'; npm start
```

| 方法与路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `POST /circuits` | 校验并保存线路（同名生成新版本） |
| `GET /circuits` / `GET /circuit?name=&version=` / `GET /versions?name=` | 列表与版本 |
| `POST /probabilities` | 逐步执行后的基态概率与每步范数 |
| `POST /exact` | 精确测量树（含 `budget`） |
| `POST /sample` | `{circuit,shots,seed}` 固定种子抽样 |
| `POST /expectation` | 指定 Pauli 串期望及逐项计算依据 |
| `POST /compare` | 两态比较，识别整体相位等价 |
| `POST /export` | `kind=state|exact|samples`，`format=json|csv` |
| `POST /snapshots` / `GET /snapshot?id=` / `GET /snapshots?name=` | 不可变结果快照 |

PowerShell 调用示例：

```powershell
$circuit = Get-Content examples/bell-measured.json -Raw | ConvertFrom-Json
$req = @{ circuit = $circuit; shots = 100; seed = 7 } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $req http://localhost:3000/sample
```

## 7. CLI

```text
qsim validate <circuit.json>
qsim save <circuit.json>
qsim run <circuit.json> [a:0 b:1]
qsim exact <circuit.json> [--max-branches N --max-steps N --max-bytes N]
qsim sample <circuit.json> --shots N --seed N
qsim expectation <circuit.json> --pauli ZI
qsim compare <a.json> <b.json>
qsim export <state|exact|samples> <json|csv> <circuit.json> [--out file]
qsim snapshot <id>
qsim list
qsim serve --port 3000
qsim demo
```

Pauli 串长度等于量子位数，按 q0..qn-1 排列，`I` 表示不作用（如 Bell 态用 `ZZ`、`XX`、`YY`）。

## 8. SQLite 持久化与不可变报告

数据库文件：`data/quantum.sqlite`。

- `circuits(name,version,definition)`：同名线路每次保存产生递增新版本，旧定义不覆盖。
- `result_snapshots`：保存算法配置（种子、shots、预算等）与结果 JSON，引用创建时的线路版本；后续编辑线路不修改旧报告。
- `npm run demo` 会保存 3 个传态输入态的线路、精确树、抽样和快照，并演示关闭后重新读取快照。

## 9. 量子传态演示

`src/cli/demo.ts` 使用 q0=输入、q1=Alice、q2=Bob：Bell 分配 → Alice 测量到经典位 `a,b` → 由 `b` 控制 X、由 `a` 控制 Z 修正 Bob。对 3 个不同输入态验证所有测量分支修正后 q2 概率恢复目标态；报告写入 `reports/teleport-report.json`。

## 10. 测试

`npm test` 覆盖：计算基编号、门/逆门、两次 H 干涉、Bell 相关测量、中途测量条件修正、零概率后选择拒绝、预算未完成、稠密矩阵交叉核对、精确分支概率和为 1、抽样可复现与纠缠关联、整体相位等价、SQLite 版本与重启读报告、12 位上限与非法参数。

## 11. 限制与合理假设

- 稠密状态向量复杂度 `O(2^n)`，12 位为硬上限；默认预算 65536 分支 / 100 万步 / 512 MB。
- 只支持表中列出的门；经典控制是测量结果的 0/1 条件，不含经典算术。
- 测量为计算基（Z 基）；其它基测量请用对应旋转门转换。
- 数值容差按线路配置，默认 `1e-9`；深度极大线路可能出现浮点漂移并在超差时报错而非自动纠正。
