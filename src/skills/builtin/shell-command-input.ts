function scalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

export function commandInput(command: string, args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const equal = raw.indexOf('=');
      if (equal >= 0) { input[raw.slice(0, equal)] = scalar(raw.slice(equal + 1)); continue; }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { input[raw] = scalar(next); i++; } else input[raw] = true;
    } else flags.push(token);
  }
  if (command === '选人' && input.count === undefined && flags[0] !== undefined) input.count = scalar(flags[0]);
  if (command === '查撤回' && input.count === undefined && flags[0] !== undefined) input.count = scalar(flags[0]);
  if (command === '重放' && input.index === undefined && flags[0] !== undefined) input.index = scalar(flags[0]);
  if (command === '课堂提醒' && input.mode === undefined && flags[0] !== undefined) input.mode = flags[0];
  return input;
}
