type LogData = Record<string, unknown> | string | number | boolean | null | undefined;

function formatData(data: LogData): string {
  if (data === undefined || data === null) return '';
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [unserializable]';
  }
}

function getCallerLocation(): string {
  const err = new Error();
  const stack = err.stack?.split('\n');
  if (!stack || stack.length < 4) return '';
  // stack[0] = "Error", [1] = getCallerLocation, [2] = log, [3] = logger.info/warn/error, [4] = actual caller
  const callerLine = stack[4];
  if (!callerLine) return '';
  // Match patterns like "at func (file:line:col)" or "at file:line:col"
  const match = callerLine.match(/\((.+):(\d+):\d+\)/) ?? callerLine.match(/at (.+):(\d+):\d+/);
  if (!match) return '';
  const filePath = match[1].replace(/^.*?\/src\//, 'src/');
  return `${filePath}:${match[2]}`;
}

function log(level: 'INFO' | 'WARN' | 'ERROR', route: string, message: string, data?: LogData): void {
  const ts = new Date().toISOString();
  const loc = getCallerLocation();
  const locStr = loc ? ` [${loc}]` : '';
  console.log(`[${ts}] [${level}] [${route}]${locStr} ${message}${formatData(data)}`);
}

export const logger = {
  info(route: string, message: string, data?: LogData): void {
    log('INFO', route, message, data);
  },
  warn(route: string, message: string, data?: LogData): void {
    log('WARN', route, message, data);
  },
  error(route: string, message: string, data?: LogData): void {
    log('ERROR', route, message, data);
  },
};
