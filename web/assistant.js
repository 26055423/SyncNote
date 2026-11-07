// 两款 EA 共用交易台连接入口；旧采集连接码保留兼容。
window.assistantPanel = () => `
<h2>连接自己的 MT5</h2>
<p class="profile-hint">SyncNote 只读同步成交与 K 线；SyncTrade 支持本机看盘与交易。两款 EA 使用同一个连接入口，网页按配对码自动识别，权限仍分别核对。</p>
<p id="assistant-status" class="profile-hint"></p>
<p><a class="primary-button" href="/chart?view=live&panel=sync&connect=1">连接 MT5</a></p>
<p class="profile-hint">在交易台输入任一 EA 图表上的 8 位配对码，网页会自动识别 SyncNote 只读同步或 SyncTrade 本机连接；无需手动选版本。输入后仍需回 MT5 核对并允许连接。</p>
<ol class="connect-steps">
  <li><a href="/local-ea">按需下载一种 EA 源码包</a>，放入 MT5 的 <code>MQL5/Experts/</code>，MetaEditor 打开入口 MQ5 按 F7 编译。</li>
  <li>SyncNote：将本站 <code id="site-url"></code> 加入 MT5 的 WebRequest HTTPS 白名单，WebsiteURL 填同一地址，ConnectionCode 留空；无需 DLL 或算法交易权限。</li>
  <li>SyncTrade：允许系统 DLL，在交易台连接时允许浏览器访问本机网络。使用本机 WebSocket，不使用 SyncNote 的 WebRequest 上传通道。</li>
  <li>挂载 EA 后点上方「连接 MT5」，输入图表配对码，再回 MT5 核对网站账号或本机连接请求并授权。配对不会上传 MT5 密码。</li>
  <li>SyncNote 收到本地同步许可并上传后，这里才会显示最近同步时间。SyncTrade 的本机交易与网页代传仍各自受原有权限及续传设置控制。</li>
</ol>
<details><summary>旧版 EA / bridge_push：使用长连接码</summary>
<p class="profile-hint">仅用于旧版兼容。生成长连接码会撤销已有同步授权，包括正在运行的 SyncNote。</p>
<div class="connect-actions">
  <button id="gen-code" type="button" class="primary-button">生成连接码</button>
  <button id="copy-code" type="button" hidden>复制连接码</button>
</div>
<label>连接码<input id="connection-code" readonly placeholder="点「生成连接码」，只显示一次" autocomplete="off"></label>
<p class="profile-hint">连接码等同密码，只填进自己的 MT5。重新生成会让旧码立刻失效——如果正在用 tools/bridge_push.py 同步，记得把新码写进 %LOCALAPPDATA%\\SyncNote\\push-token.txt 再重启同步。</p>
<p id="connection-feedback" class="form-feedback" role="status"></p></details>`;

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
