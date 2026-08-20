import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { COMMAND_BROKER_EFFECT_MARKER, type CommandBrokerRequest, type CommandBrokerResponse } from '../msp/command-protocol';
import { cliPluginManifests } from './plugins';
import { rollDice } from '../skills/example/dice';
import { validateArgs } from '../skills/registry';

function parseArgs(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const raw = token.slice(2);
    const equal = raw.indexOf('=');
    if (equal >= 0) { args[raw.slice(0, equal)] = scalar(raw.slice(equal + 1)); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[raw] = scalar(next); i++; } else args[raw] = true;
  }
  return args;
}

function scalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

function usage(): never {
  process.stderr.write('用法：msp-plugin <command> [--key value]\n');
  process.exit(2);
}

async function invokeBroker(plugin: string, command: string, args: string[], input: Record<string, unknown>): Promise<void> {
  const socketPath = process.env.AL1S_COMMAND_SOCKET;
  const auth = process.env.AL1S_COMMAND_TOKEN;
  const contextRaw = process.env.AL1S_COMMAND_CONTEXT;
  if (!socketPath || !auth || !contextRaw) {
    process.stderr.write('命令代理未配置\n');
    process.exitCode = 125;
    return;
  }
  const context = JSON.parse(Buffer.from(contextRaw, 'base64url').toString('utf8')) as CommandBrokerRequest['context'];
  const request: CommandBrokerRequest = {
    protocol: 'al1s.command-broker.v1',
    id: randomUUID(),
    auth,
    op: 'invoke',
    plugin,
    command,
    args,
    input,
    source: process.env.AL1S_COMMAND_SOURCE === 'agent' ? 'agent' : process.env.AL1S_COMMAND_SOURCE === 'cli' ? 'cli' : 'chat',
    context: { ...context, source: process.env.AL1S_COMMAND_SOURCE === 'agent' ? 'agent' : process.env.AL1S_COMMAND_SOURCE === 'cli' ? 'cli' : 'chat', input },
  };
  const response = await new Promise<CommandBrokerResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('命令代理超时')); }, 120_000);
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(buffer.slice(0, index)) as CommandBrokerResponse); } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
  if (response.stdout) process.stdout.write(`${response.stdout}\n`);
  if (response.stderr) process.stderr.write(`${response.stderr}\n`);
  if (response.effects.length > 0) {
    const encodedEffects = Buffer.from(JSON.stringify(response.effects), 'utf8').toString('base64url');
    process.stderr.write(`${COMMAND_BROKER_EFFECT_MARKER}${encodedEffects}\n`);
  }
  process.exitCode = response.exitCode;
}

const [rawCommand, ...rest] = process.argv.slice(2);
if (!rawCommand) usage();
const manifest = cliPluginManifests.find((item) => item.commands.some((spec) => spec.name === rawCommand || spec.aliases?.includes(rawCommand)));
if (!manifest) {
  process.stderr.write(`command not found: ${rawCommand}\n`);
  process.exitCode = 127;
} else {
  const spec = manifest.commands.find((item) => item.name === rawCommand || item.aliases?.includes(rawCommand));
  const input = parseArgs(rest);
  try {
    if (spec?.inputSchema) validateArgs(spec.inputSchema, input);
    const command = spec?.name ?? rawCommand;
    if (manifest.name === 'dice') process.stdout.write(`${rollDice(input)}\n`);
    else await invokeBroker(manifest.name, command, rest, input);
  } catch (error) {
    process.stderr.write(`参数或命令执行失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
