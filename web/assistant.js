// 独立源码版没有原生安装助手：连接 MT5 全靠这里的「生成连接码」+ MQ5 采集程序。
window.assistantPanel = () => `
<h2>连接自己的 MT5</h2>
<p class="profile-hint">采集程序只上传成交历史，不下单。连接码只显示一次，生成后立刻复制。</p>
<p id="assistant-status" class="profile-hint"></p>
<div class="connect-actions">
  <button id="gen-code" type="button" class="primary-button">生成连接码</button>
  <button id="copy-code" type="button" hidden>复制连接码</button>
</div>
<label>连接码<input id="connection-code" readonly placeholder="点「生成连接码」，只显示一次" autocomplete="off"></label>
<p class="profile-hint">连接码等同密码，只填进自己的 MT5。重新生成会让旧码立刻失效——如果正在用 tools/bridge_push.py 同步，记得把新码写进 %LOCALAPPDATA%\\SyncNote\\push-token.txt 再重启同步。</p>
<ol class="connect-steps">
  <li>点「生成连接码」并复制（忘了就重新生成一个）。</li>
  <li><a href="/local-ea">按需要下载一个 EA 源码包</a>：<b>SyncNote</b>（只读历史，不需要 DLL，关掉浏览器也继续同步）或 <b>SyncTrade</b>（多一个本机 WebSocket，可在网页看盘、模拟账户下单）。用 MetaEditor 打开入口 MQ5 按 F7 编译。</li>
  <li>MT5 → 工具 → 选项 → EA 交易：勾选「允许 WebRequest」，把 <code id="site-url"></code> 加进白名单。</li>
  <li>把 SyncNote 拖到任意图表（SyncTrade 请在要交易的品种图表上挂），<b>WebsiteURL</b> 填同一个地址，<b>ConnectionCode</b> 粘贴连接码。</li>
  <li>EA 图表左上角会显示同步状态；几秒后这里的状态变成「最近同步」，交易记录与复盘图会陆续出现。首次补录按时间片分页，历史多时需要几分钟。</li>
</ol>
<p id="connection-feedback" class="form-feedback" role="status"></p>`;

window.bindAssistant = () => {
  const gen = document.getElementById('gen-code');
  if (!gen) return;
  const code = document.getElementById('connection-code');
  const copy = document.getElementById('copy-code');
  const feedback = document.getElementById('connection-feedback');
  const site = document.getElementById('site-url');
  if (site) site.textContent = location.origin;

  gen.onclick = async () => {
    if (!confirm('生成新连接码会让旧连接码立即失效，正在同步的 EA / bridge_push 会断开。确定继续？')) return;
    gen.disabled = true;
    feedback.textContent = '正在生成…';
    try {
      const result = await window.syncnoteAPI('/api/mt5/token', {});
      code.value = result.token;
      copy.hidden = false;
      feedback.textContent = '已生成。复制后填进 MT5 的 ConnectionCode；旧连接码已自动失效。';
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      gen.disabled = false;
    }
  };

  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      feedback.textContent = '已复制到剪贴板';
    } catch {
      code.select();
      feedback.textContent = '浏览器没给剪贴板权限，已选中，手动复制即可';
    }
  };
};
