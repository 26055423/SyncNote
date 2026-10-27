/** 同频 API 客户端：读请求短重试，写请求不重试，401 统一回登录页。 */
export async function api<T = any>(path: string, data?: unknown, init?: { keepalive?: boolean }): Promise<T> {
  const writing = data !== undefined;
  for (let attempt = 0; attempt < (writing ? 1 : 3); attempt += 1) {
    let response: Response;
    try {
      response = await fetch(path, {
        cache: 'no-store',
        credentials: 'same-origin',
        keepalive: init?.keepalive,
        headers: { Accept: 'application/json', ...(writing ? { 'Content-Type': 'application/json' } : {}) },
        ...(writing ? { method: 'POST', body: JSON.stringify(data) } : {}),
      });
    } catch {
      if (!writing && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        continue;
      }
      throw new Error('网络连接中断，请稍后重试');
    }
    if (response.status === 401) {
      location.replace('/login');
      throw new Error('登录已过期，请重新登录');
    }
    const isJSON = (response.headers.get('Content-Type') || '').includes('application/json');
    if (!isJSON) {
      if (!writing && attempt < 2 && [200, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        continue;
      }
      throw new Error('网站连接暂时异常（HTTP ' + response.status + '），请稍后重试');
    }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败（HTTP ' + response.status + '）');
    return value as T;
  }
  throw new Error('请求失败，请稍后重试');
}

export const BEIJING = 'Asia/Shanghai';

export function stamp(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '时间待校准';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: BEIJING, hour12: false });
}

export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
