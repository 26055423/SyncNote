// 独立源码版没有原生安装助手：连接 MT5 全靠这里的「生成连接码」+ MQ5 采集程序。
window.assistantPanel = () => `
<h2>连接自己的 MT5</h2>
<p class="profile-hint">采集程序只上传交易数据，不下单。连接码只显示一次，生成后立刻复制。</p>
<p id="assistant-status" class="profile-hint"></p>
<div class="connect-actions">
  <button id="gen-code" type="button" class="primary-button">生成连接码</button>
  <button id="copy-code" type="button" hidden>复制连接码</button>
</div>
<label>连接码<input id="connection-code" readonly placeholder="点「生成连接码」，只显示一次" autocomplete="off"></label>
<p class="profile-hint">连接码等同密码，只填进自己的 MT5。重新生成会让旧码立刻失效。</p>
<ol class="connect-steps">
  <li>点「生成连接码」并复制（忘了就重新生成一个）。</li>
  <li><a href="/downloads/TongpinSync.mq5" download>下载 TongpinSync.mq5 源码</a>，用 MT5 的 MetaEditor 打开并按 F7 编译。</li>
  <li>MT5 → 工具 → 选项 → EA 交易：勾选「允许 WebRequest」，把 <code id="site-url"></code> 加进白名单。</li>
  <li>把 TongpinSync 拖到任意图表，<b>WebsiteURL</b> 填同一个地址，<b>ConnectionCode</b> 粘贴连接码。</li>
  <li>约 5 秒内上面的状态会变成「MT5 已连接，正在盯盘」，看板就会出现你的账户和交易。</li>
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
    gen.disabled = true;
    feedback.textContent = '正在生成…';
    try {
      const result = await window.tongpinAPI('/api/mt5/token', {});
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
