const $ = (id) => document.getElementById(id);

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('tab--active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('panel--active', p.id === `panel-${name}`);
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function setIssuedAtDefault() {
  const el = $('gen-issued-at');
  if (!el.value) {
    el.value = new Date().toISOString().split('T')[0];
  }
}

function syncLicenseModeUi() {
  const perm = document.querySelector('input[name="license-mode"]:checked')?.value === 'permanent';
  $('lbl-activate-before').classList.toggle('hidden', !perm);
  $('gen-activate-before').classList.toggle('hidden', !perm);
  $('lbl-valid-days').classList.toggle('hidden', perm);
  $('gen-valid-days').classList.toggle('hidden', perm);
  if (perm && !$('gen-activate-before').value) {
    const d = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    $('gen-activate-before').value = d;
  }
}

document.querySelectorAll('input[name="license-mode"]').forEach((r) => {
  r.addEventListener('change', syncLicenseModeUi);
});

async function refreshKeyStatus() {
  const box = $('key-status');
  if (!window.adminGui) {
    box.textContent = '未检测到 Electron 预加载脚本（请使用 npm start 启动本工具）。';
    return;
  }
  const s = await window.adminGui.getKeyStatus();
  if (!s.ok) {
    box.textContent = '读取失败';
    return;
  }
  box.textContent = [
    `私钥: ${s.hasPrivate ? '已找到' : '未找到'}`,
    `  → ${s.privatePath}`,
    `公钥: ${s.hasPublic ? '已找到' : '未找到'}`,
    `  → ${s.publicPath}`,
    s.publicHexPreview ? `公钥 Hex 前缀: ${s.publicHexPreview}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

$('btn-refresh-keys').addEventListener('click', () => void refreshKeyStatus());

$('btn-init-keys').addEventListener('click', async () => {
  const out = $('init-result');
  out.classList.add('hidden');
  if (!window.adminGui) return;
  const overwrite = $('init-overwrite').checked;
  const r = await window.adminGui.initKeys(overwrite);
  out.classList.remove('hidden');
  if (!r.ok) {
    out.textContent = `❌ ${r.error}`;
    return;
  }
  out.textContent = [
    '✅ 已生成密钥对',
    '',
    '公钥 Hex（请同步到客户端源码）:',
    r.publicHex,
    '',
    '路径:',
    JSON.stringify(r.paths, null, 2),
    '',
    r.hint || '',
  ].join('\n');
  await refreshKeyStatus();
});

let lastGeneratedCode = '';

$('btn-generate').addEventListener('click', async () => {
  const errEl = $('gen-error');
  const out = $('gen-output');
  errEl.classList.add('hidden');
  lastGeneratedCode = '';
  $('btn-copy-code').disabled = true;
  $('btn-save-code').disabled = true;

  const licenseMode = document.querySelector('input[name="license-mode"]:checked')?.value || 'time_limited';
  const params = {
    deviceCode: $('gen-device-code').value.trim(),
    hwId: $('gen-hw-id').value.trim(),
    licenseMode,
    issuedAt: $('gen-issued-at').value,
    activateBefore: $('gen-activate-before').value,
    validUntilDays: Number($('gen-valid-days').value) || 30,
    batchId: $('gen-batch').value.trim(),
    customerRef: $('gen-customer').value.trim(),
  };

  const r = await window.adminGui.generateLicense(params);
  if (!r.ok) {
    errEl.textContent = r.error || '生成失败';
    errEl.classList.remove('hidden');
    out.value = '';
    return;
  }
  lastGeneratedCode = r.licenseCode;
  out.value = r.licenseCode;
  $('btn-copy-code').disabled = false;
  $('btn-save-code').disabled = false;
});

$('btn-copy-code').addEventListener('click', async () => {
  if (!lastGeneratedCode) return;
  try {
    await navigator.clipboard.writeText(lastGeneratedCode);
    $('gen-error').classList.add('hidden');
  } catch {
    $('gen-error').textContent = '复制失败，请手动全选复制';
    $('gen-error').classList.remove('hidden');
  }
});

$('btn-save-code').addEventListener('click', async () => {
  if (!lastGeneratedCode) return;
  const r = await window.adminGui.saveLicenseToFile(lastGeneratedCode);
  if (r.canceled) return;
  if (!r.ok) {
    $('gen-error').textContent = r.error || '保存失败';
    $('gen-error').classList.remove('hidden');
    return;
  }
  $('gen-error').classList.add('hidden');
  $('gen-output').value = `${lastGeneratedCode}\n\n（已保存: ${r.path}）`;
});

$('btn-verify').addEventListener('click', async () => {
  const pre = $('verify-result');
  pre.classList.remove('hidden');
  const code = $('verify-input').value.trim();
  if (!code) {
    pre.textContent = '请输入激活码';
    return;
  }
  const r = await window.adminGui.verifyLicense(code);
  if (!r.ok) {
    pre.textContent = `❌ ${r.error}`;
    return;
  }
  pre.textContent = [
    '✅ 解析成功',
    `签名验证: ${r.sigValid ? '✅ 通过' : '❌ 失败'}`,
    r.sigError ? `  详情: ${r.sigError}` : '',
    '',
    '载荷 JSON:',
    JSON.stringify(r.payload, null, 2),
  ]
    .filter(Boolean)
    .join('\n');
});

$('btn-device-calc').addEventListener('click', async () => {
  const pre = $('device-result');
  pre.classList.remove('hidden');
  const r = await window.adminGui.deviceCodeFromHwFields({
    machineGuid: $('dev-machine-guid').value,
    cpuId: $('dev-cpu').value,
    diskSerial: $('dev-disk').value,
    macAddress: $('dev-mac').value,
  });
  if (!r.ok) {
    pre.textContent = `❌ ${r.error}`;
    return;
  }
  pre.textContent = [
    `HW_ID:\n${r.hwId}`,
    '',
    `短 HW_ID: ${r.shortHwId}`,
    '',
    `激活设备码:\n${r.deviceCode}`,
  ].join('\n');
});

setIssuedAtDefault();
syncLicenseModeUi();
void refreshKeyStatus();
