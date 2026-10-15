## 1. 准备与设计
- [x] 1.1 核对 evaluate、WorkerProcess、IPC 和模型选择接口。
- [x] 1.2 明确 process/container 选择、默认值、失败语义及实现边界。
- [x] 1.3 实际探测 macOS 写策略与 Docker daemon/镜像可用性。
- [x] 1.4 OpenSpec 严格校验与项目记忆接续。

## 2. 隔离执行与可信通信
- [x] 2.1 自行实现最小 OS 包装，验证文件读写、网络/socket、信号与后台子进程边界；macOS 单进程，Linux PID namespace。
- [x] 2.2 实现候选专用流式通信与宿主结果收集，不信任 PID/management 消息，限制消息资源占用。
- [x] 2.3 实现 macOS/Linux 进程后端，从候选加载前隔离；不可用明确失败。Linux 已在允许 namespace 的临时 Linux 测试环境验证。
- [x] 2.4 实现容器后端、Linux 依赖准备及非 root/只读根/资源限制。
- [x] 2.5 实现受限模型出口，避免宿主长期凭据透传和任意网络代理。
- [x] 2.6 实现取消、超时、正常退出、宿主被杀/重启后的完整回收。

## 3. evaluate 接入
- [x] 3.1 Supervisor 强制沙箱；management/CLI 支持模型选择，不支持 none。
- [x] 3.2 保留现有 evidence/decide/promote，记录实际后端和失败原因，不修改主实例权限。
- [x] 3.3 验证旧候选入口兼容；不兼容明确失败，不运行旧无沙箱路径。

## 4. 验收
- [x] 4.1 真实受限进程执行轻量 prompt 评测，不依赖 Docker。
- [x] 4.2 真实容器执行候选，验证 Linux 依赖、文件产物、模型出口及回收。
- [x] 4.3 真实攻击性样例：越界读写、符号链接、控制 socket、伪造 PID、任意外联、后台进程、输出耗尽。
- [x] 4.4 取消/超时/启动失败/宿主中断验证；沙箱不可用和 none 请求必须拒绝。
- [x] 4.5 类型检查、相关回归、完整回归、OpenSpec 校验与使用文档。
- [x] 4.6 隔离 SEEDA_HOME 下端到端 evaluate→evidence→decide→promote，验证原有接替规则（runtime 与 agent-graft 真实进程测试，本地模拟模型）。
