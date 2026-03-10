type LogData = Record<string, unknown> | string | number | boolean | null | undefined;

function formatData(data: LogData): string {
  if (data === undefined || data === null) return '';
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [unserializable]';
  }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', route: string, message: string, data?: LogData): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [${route}] ${message}${formatData(data)}`);
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
