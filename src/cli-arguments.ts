export class UsageError extends Error {}
const helpFlags = ['-h', '--help'];
const versionFlags = ['-v', '--version'];
export const managementCommands = ['strains','seed','publish','init','serve','status','draft','submit','evaluate','evidence','decide','promote','rollback','select','stop'];
export const help = `用法：seeda                         进入 TUI，新项目先选择种系
      seeda run "任务文本"          执行明确的 Agent 任务
      seeda -- "字面任务文本"       任务可包含控制命令或短横线

种系与播种：
  strains                          浏览种系
  strains default NAME             设置未来播种默认
  seed [NAME 或 ID]                 初始化，不填时交互选择
  publish NAME [VERSION] --intro FILE
                                   发布保存版本，附带五项介绍

运行管理：
  status | draft | stop             状态、创建候选、停止守护
  submit DRAFT REASON               保存候选
  evaluate VERSION TASK            独立验证
  evidence EVALUATION               查询证据
  decide EVALUATION accept|reject REASON
  promote VERSION EVALUATION REASON
  rollback REASON | select VERSION
  init [SOURCE] | serve [PROJECT]   显式初始化/前台守护

选项：-h/--help · -v/--version（入口版本）
TUI：/new /sessions /resume ID /compact /versions /use ID /rollback /exit
环境：DEEPSEEK_API_KEY · SEEDA_LIBRARY · SEEDA_HOME · SEEDA_MANAGED
未知命令不会作为任务发送；任务请用 run 或 --。`;
function arity(args: string[], min: number, max = min): void {
  if (args.length < min || args.length > max || args.some(arg => !arg.trim())) throw new UsageError('参数数量不正确或参数为空。使用 seeda --help 查看用法。');
}
export function slashCommand(input: string): string {
  const args = input.trim().split(/\s+/); const command = args.shift()!;
  const simple = ['/new','/sessions','/compact','/versions','/rollback','/exit'];
  if (simple.includes(command)) arity(args,0);
  else if (['/resume','/use'].includes(command)) arity(args,1);
  else throw new UsageError(`未知控制命令：${command}`);
  return [command,...args].join(' ');
}
function requestsHelp(args: string[]): boolean {
  return args.some((arg,index) => helpFlags.includes(arg) && args[index - 1] !== '--intro');
}
export function managementArgs(argv: string[], internal = false): string[] {
  const [command = 'status', ...args] = argv;
  if (!managementCommands.includes(command) && !(internal && command === 'auto-serve')) throw new UsageError(`未知命令：${command}`);
  if (command === 'publish') {
    const positional: string[] = []; let intro: string | undefined;
    for (let i=0;i<args.length;i++) {
      const arg=args[i];
      if (arg==='--intro' || arg.startsWith('--intro=')) {
        if (intro !== undefined) throw new UsageError('重复 --intro 选项');
        intro=arg==='--intro' ? args[++i] : arg.slice(8);
        if (!intro?.trim() || intro.startsWith('-')) throw new UsageError('--intro 必须提供文件路径');
      } else if (arg.startsWith('-')) throw new UsageError(`未知选项：${arg}`);
      else positional.push(arg);
    }
    arity(positional,1,2); if (!intro) throw new UsageError('publish 必须提供 --intro FILE');
    return [command,...positional,'--intro',intro];
  }
  const bad=args.find(arg=>arg.startsWith('-')); if (bad) throw new UsageError(`未知选项：${bad}`);
  if (command==='strains') {
    if (!args.length) return [command];
    if (args[0]!=='default') throw new UsageError(`未知 strains 操作：${args[0]}`);
    arity(args,2); return [command,...args];
  }
  const counts: Record<string,[number,number]> = {seed:[0,1],init:[0,1],serve:[0,1],'auto-serve':[1,1],status:[0,0],draft:[0,0],stop:[0,0],submit:[2,2],evaluate:[2,2],evidence:[1,1],decide:[3,3],promote:[3,3],rollback:[1,1],select:[1,1]};
  arity(args,...counts[command]);
  if (command==='decide' && !['accept','reject'].includes(args[1])) throw new UsageError('decide 需要 accept 或 reject');
  return [command,...args];
}
export function parseArgs(args: string[], runtime = false): {kind:'help'|'version'|'interactive'|'task'|'control'|'manage'|'exit'; args?:string[]; prompt?:string} {
  if (args[0]==='--') { arity(args.slice(1),1,Number.MAX_SAFE_INTEGER); return {kind:'task',prompt:args.slice(1).join(' ')}; }
  if (['help',...helpFlags].includes(args[0] ?? '')) { arity(args.slice(1),0); return {kind:'help'}; }
  if (versionFlags.includes(args[0] ?? '')) { arity(args.slice(1),0); return {kind:'version'}; }
  if (args[0]==='run' && !runtime) {
    if (args[1]==='--') { arity(args.slice(2),1,Number.MAX_SAFE_INTEGER); return {kind:'task',prompt:args.slice(2).join(' ')}; }
    if (requestsHelp(args.slice(1))) return {kind:'help'};
    arity(args.slice(1),1,Number.MAX_SAFE_INTEGER);
    const bad=args.slice(1).find(arg=>arg.startsWith('-'));if(bad)throw new UsageError(`未知任务选项：${bad}，字面文本请用 run --`);
    return {kind:'task',prompt:args.slice(1).join(' ')};
  }
  if (!args.length && !runtime) return {kind:'interactive'};
  if (args[0]?.startsWith('/') && !runtime) { const prompt=slashCommand(args.join(' ')); return {kind:prompt==='/exit'?'exit':'control',prompt}; }
  if (managementCommands.includes(args[0] ?? 'status') || (runtime && args[0]==='auto-serve')) {
    if (requestsHelp(args)) return {kind:'help'};
    return {kind:'manage',args:managementArgs(args,runtime)};
  }
  throw new UsageError(`未知命令：${args[0]}。任务请使用 seeda run "任务" 或 seeda -- "任务"。`);
}
