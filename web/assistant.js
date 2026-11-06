// SyncNote 只读同步与 SyncTrade 本机交易分别配对；旧采集连接码保留兼容。
window.assistantPanel = () => `
<h2>连接自己的 MT5</h2>
<p class="profile-hint">SyncNote 只读同步成交与 K 线，不下单；MT5 运行时，关掉网页也继续同步。SyncTrade 本机交易请在交易台单独配对。</p>
<p id="assistant-status" class="profile-hint"></p>
<form id="syncnote-pair-form">
  <label for="syncnote-device-code">SyncNote 图表上的 8 位同步配对码<input id="syncnote-device-code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="off" placeholder="00000000" required aria-describedby="syncnote-pair-help syncnote-pair-feedback"></label>
  <button id="syncnote-device-submit" type="submit" class="primary-button">配对只读同步</button>
  <p id="syncnote-pair-help" class="profile-hint">在 MT5 挂载 SyncNote 1.012，ConnectionCode 留空。填入 EA 显示的配对码，再回 MT5 核对同频账号并允许同步。配对码 10 分钟内有效。</p>
  <p id="syncnote-pair-feedback" class="form-feedback" role="status" aria-live="polite"></p>
</form>
<ol class="connect-steps">
  <li><a href="/local-ea">下载 SyncNote 源码包</a>，放入 MT5 的 <code>MQL5/Experts/SyncNote/</code>，MetaEditor 打开入口 MQ5 按 F7 编译。</li>
  <li>MT5 → 工具 → 选项 → EA 交易：勾选「允许 WebRequest」，把 <code id="site-url"></code> 加进白名单。无需 DLL 或算法交易权限。</li>
  <li>将 SyncNote 挂到图表，WebsiteURL 填同一个地址，ConnectionCode 留空。把图表显示的 8 位同步配对码填到上方。</li>
  <li>回 MT5 核对同频账号，点击「允许只读同步」。拒绝或过期后，在 EA 点击「重新生成配对码」，再用新码配对；批准前不会上传成交与 K 线。</li>
  <li>EA 收到授权并开始上传后，这里的状态才会显示最近同步时间。首次补录可能需要几分钟。授权凭据只保存在本机、按网站与 MT5 账户隔离，重启复用。</li>
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

  const pairForm = document.getElementById('syncnote-pair-form');
  const pairCode = document.getElementById('syncnote-device-code');
  const pairSubmit = document.getElementById('syncnote-device-submit');
  const pairFeedback = document.getElementById('syncnote-pair-feedback');
  pairCode.oninput = () => { pairCode.value = pairCode.value.replace(/\D/g, '').slice(0, 8); };
  pairForm.onsubmit = async (event) => {
    event.preventDefault();
    if (pairSubmit.disabled || !/^\d{8}$/.test(pairCode.value)) return;
    pairSubmit.disabled = true;
    pairFeedback.textContent = '正在提交配对码…';
    try {
      await window.syncnoteAPI('/api/mt5/device/claim', { code: pairCode.value });
      pairCode.value = '';
      pairFeedback.textContent = '请回 MT5 图表核对同频账号并点击「允许只读同步」。完成授权并上传后，才会显示最近同步时间。';
    } catch (error) { pairFeedback.textContent = error.message; }
    finally { pairSubmit.disabled = false; }
  };

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
