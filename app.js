/*
 * app.js — システム1 固定QR打刻ページ ロジック（B1 / 呼び出しのみ・判定はGAS）
 *
 * 設計の正：
 *   - docs/system1_勤怠給与/デザイン/打刻ページ.md（4画面フロー・状態・英語UI文言）
 *   - docs/system1_勤怠給与/設計/打刻・承認設計.md（A6：短命トークン・PIN・監査）
 *   - GAS：10_punch_api.gs（doGet ?action=token / doPost verifyPin / punch）
 *
 * 責務：画面遷移 ＋ API呼び出し ＋ 結果表示。本人特定・トークン検証・記録はすべてGAS側。
 *
 * 通信方針（B1）：
 *   - fetch は text/plain で POST（Content-Type を application/json にしない）。
 *     これでブラウザのCORSプリフライト（OPTIONS）を回避できる。GAS WebApp は doPost で
 *     e.postData.contents を JSON.parse する前提。
 *   - 二重送信防止：送信中はボタンを無効化＋スピナー（二重打刻の物理的防止）。
 *   - オフライン時は打刻不成立を明示（端末キューで成功と誤認させない）。
 */

'use strict';

// =============================================================================
// CONFIG — デプロイ時にここを差し替える
//   API_URL：GAS WebApp の exec URL（プレースホルダ）。
//   COMPANY_NAME：ヘッダ表示の社名（ロゴ未定のためテキスト・B1未確定事項3）。
// =============================================================================
var CONFIG = {
  // ★ 必須：GAS WebApp の公開URL（…/exec）に差し替える
  API_URL: 'https://script.google.com/macros/s/AKfycbyKJS9038Jwi_keAO7t-oj32yJbhyan0pmrZufc-v6F1TkP6at_gns1dVavtGoZFBymGQ/exec',
  COMPANY_NAME: 'SAKANAYA JAPON',
  // 結果画面の自動初期化（秒）。0 で自動戻りなし（B1未確定事項5：暫定5秒）。
  AUTO_RETURN_SECONDS: 5,
  // 応答が遅い時に「まだ処理中」を出す閾値（ms。B1 §4：3秒）
  SLOW_HINT_MS: 3000,
  // fetch のタイムアウト（ms）。遅すぎる回線で無限待ちを避ける。
  REQUEST_TIMEOUT_MS: 15000
};

// =============================================================================
// 英語UI文言マップ（将来の調整・多言語化に備えて一箇所に集約・B1 §8）
// =============================================================================
var TEXT = {
  start: 'Start',
  preparing: 'Preparing…',
  continueLabel: 'Continue',
  punch: 'Punch',
  punchIn: 'Punch In',
  punchOut: 'Punch Out',
  submitting: 'Submitting…',
  done: 'Done',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  // PIN
  pinIncorrect: 'Incorrect PIN. Please try again.',
  pinLocked: 'Too many attempts. Please wait {s}s or contact HR.',
  // Result titles/messages
  successInTitle: 'Punched In\nsuccessfully',
  successOutTitle: 'Punched Out\nsuccessfully',
  serverNote: 'Recorded on the server',
  // reject reasons (B1 §4-c)
  rejectDupTitle: 'Couldn’t punch',
  rejectDupTodo: 'If this is a mistake, contact HR.',
  tokenExpiredTitle: 'Session expired',
  tokenExpiredMsg: 'This QR session has expired.',
  tokenExpiredTodo: 'Please scan the QR code again.',
  tokenReusedTitle: 'Couldn’t punch',
  tokenReusedMsg: 'This QR session was already used.',
  tokenReusedTodo: 'Please scan the QR code again to get a fresh session.',
  flaggedTitle: 'Punch recorded — under review',
  flaggedMsg: 'Your punch was recorded but flagged for review.',
  flaggedTodo: 'No action needed. HR may follow up.',
  serverErrTitle: 'Something went wrong',
  serverErrMsg: 'We couldn’t reach the server.',
  serverErrTodo: 'Please try again in a moment.',
  // token start failure (B1 §5-5)
  startFailTitle: 'Couldn’t start',
  startFailMsg: 'We couldn’t start a punch session.',
  startFailTodo: 'Please scan the QR code again.',
  // offline (B1 §5-4)
  offlineTitle: 'No connection',
  offlineMsg: 'You’re offline. Your punch was not recorded.',
  // last punch
  lastPunch: 'Last punch: {type} at {time} today',
  alreadyIn: 'Already clocked in at {time}',
  alreadyOut: 'Already clocked out at {time}',
  returning: 'Returning in {s}s…',
  // 場所確認 / 現場QR（ローテQR＋GPS）
  tooFarTitle: 'Not at the shop',
  tooFarMsg: 'Your location is outside the shop area, so the punch was not recorded.',
  tooFarTodo: 'Punch while at the shop, and allow location access.',
  qrRequiredTitle: 'Scan the shop QR',
  qrRequiredMsg: 'Please scan the QR shown on the shop tablet.',
  qrRequiredTodo: 'A saved or old QR no longer works. Scan the live QR on the tablet.'
};

// =============================================================================
// アプリ状態
// =============================================================================
var STATE = {
  token: null,          // 短命トークン（doGet で取得）
  pin: '',              // 入力中PIN（最大6桁）
  employeeId: null,     // verifyPin で確定
  employeeName: null,
  lastPunch: null,      // {type, timeDisplay, dateStr} or null
  selectedType: null,   // 'in' | 'out'
  busy: false,          // 送信中フラグ（二重送信防止の最終ガード）
  autoReturnTimer: null,
  displayCode: null,    // QRの c（表示コード。現場QR必須のとき token 取得に同梱）
  geo: null             // {lat,lng} or null（GPS位置。打刻時にサーバへ送る）
};

var PIN_LENGTH = 6; // PIN桁数（A6/B1：6桁）

// 要素キャッシュ
var el = {};

// =============================================================================
// 初期化
// =============================================================================
document.addEventListener('DOMContentLoaded', function () {
  cacheElements();
  el.companyName.textContent = CONFIG.COMPANY_NAME;
  STATE.displayCode = _readDisplayCode_();
  startDeviceClock();
  renderWelcomeDate();
  bindEvents();
  bindConnectivity();
  showScreen('welcome');
});

// QRの c（表示コード）をURLから読む（現場QR必須のとき token 取得に同梱）
function _readDisplayCode_() {
  try { return new URLSearchParams(location.search).get('c') || null; }
  catch (e) { return null; }
}

// GPS座標を取得（許可されなければ null）。打刻時にサーバへ送り、店舗近傍かを確認させる。
function _getGeo_() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { resolve(null); return; }
    var done = false;
    var finish = function (v) { if (done) { return; } done = true; resolve(v); };
    setTimeout(function () { finish(null); }, 9000);
    navigator.geolocation.getCurrentPosition(
      function (pos) { finish({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      function () { finish(null); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}

function cacheElements() {
  var ids = [
    'companyName', 'deviceClock', 'welcomeDate', 'offlineBanner', 'bannerTitle', 'bannerMsg',
    'screenWelcome', 'screenPin', 'screenAction', 'screenResult',
    'pinDots', 'pinShown', 'pinError', 'pinToggle', 'keypad',
    'actionHello', 'actionEmpId', 'actionLast',
    'choiceIn', 'choiceOut', 'choiceInWarn', 'choiceOutWarn',
    'resultBadge', 'resultIcon', 'resultTitle', 'resultWho', 'resultTime',
    'resultServerNote', 'resultHelpBlock', 'resultTodo', 'resultReturn',
    'btnStart', 'btnContinue', 'btnPunch', 'btnCancel', 'btnDone', 'btnTryAgain', 'btnGetHelp',
    'liveRegion'
  ];
  ids.forEach(function (id) { el[id] = document.getElementById(id); });
  el.screenPinRoot = el.screenPin; // .pin クラスのルート（is-error/is-show 等の付与先）
}

// =============================================================================
// 端末時計（参考表示・サーバ時刻ではない旨は結果画面で明示・B1 §2）
// =============================================================================
function startDeviceClock() {
  function tick() {
    var now = new Date();
    var hh = pad2(now.getHours());
    var mm = pad2(now.getMinutes());
    el.deviceClock.textContent = hh + ':' + mm + ' ICT';
  }
  tick();
  setInterval(tick, 15000);
}

function renderWelcomeDate() {
  // 例：Mon, 16 Jun 2026（端末ロケール非依存で英語固定表記）
  var now = new Date();
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  el.welcomeDate.textContent =
    days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
}

// =============================================================================
// イベント結線
// =============================================================================
function bindEvents() {
  el.btnStart.addEventListener('click', onStart);

  // キーパッド（イベント委譲）
  el.keypad.addEventListener('click', onKeypadClick);
  el.pinToggle.addEventListener('click', onTogglePin);
  el.btnContinue.addEventListener('click', onContinue);

  // 物理キーボード対応（任意端末でのテスト・アクセシビリティ）
  document.addEventListener('keydown', onPhysicalKey);

  el.choiceIn.addEventListener('click', function () { selectType('in'); });
  el.choiceOut.addEventListener('click', function () { selectType('out'); });
  el.btnPunch.addEventListener('click', onPunch);
  el.btnCancel.addEventListener('click', resetToWelcome);

  el.btnDone.addEventListener('click', resetToWelcome);
  el.btnTryAgain.addEventListener('click', onTryAgain);
  el.btnGetHelp.addEventListener('click', onGetHelp);
}

function bindConnectivity() {
  window.addEventListener('online', function () { hideBanner(); });
  window.addEventListener('offline', function () {
    showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
  });
  if (!navigator.onLine) {
    showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
  }
}

// =============================================================================
// 画面切替（footer ボタンの表示も画面に応じて出し分け）
// =============================================================================
var FOOTER_BY_SCREEN = {
  welcome: ['btnStart'],
  pin: ['btnContinue'],
  action: ['btnPunch', 'btnCancel'],
  'result-success': ['btnDone'],
  'result-reject': ['btnTryAgain', 'btnGetHelp']
};

function showScreen(name) {
  // セクションの is-active を切替（result-* は result セクションを活性化＝ポップイン）
  var isResult = name.indexOf('result') === 0;
  el.screenWelcome.classList.toggle('is-active', name === 'welcome');
  el.screenPin.classList.toggle('is-active', name === 'pin');
  el.screenAction.classList.toggle('is-active', name === 'action');
  // ポップイン animation を毎回発火させるため、一旦 is-active を外してから再付与する
  el.screenResult.classList.remove('is-active');
  if (isResult) {
    // reflow を挟んで animation を確実に再生（同じ result-* の連続表示でも発火させる）
    void el.screenResult.offsetWidth;
    el.screenResult.classList.add('is-active');
  }

  // フッタボタン：いったん全部隠す→該当画面のものだけ表示
  ['btnStart', 'btnContinue', 'btnPunch', 'btnCancel', 'btnDone', 'btnTryAgain', 'btnGetHelp']
    .forEach(function (id) { el[id].style.display = 'none'; });

  var footerKey = name;
  var show = FOOTER_BY_SCREEN[footerKey] || [];
  show.forEach(function (id) { el[id].style.display = ''; });
}

// =============================================================================
// Screen 1: Welcome → Start（短命トークン取得）
// =============================================================================
function onStart() {
  if (STATE.busy) { return; }
  if (!navigator.onLine) {
    showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
    return;
  }
  setButtonLoading(el.btnStart, true, TEXT.preparing);
  STATE.busy = true;

  // 先にGPSを取得（許可ダイアログ）→ 表示コード c と一緒に token を要求
  _getGeo_().then(function (coords) {
    STATE.geo = coords;
    var params = { action: 'token', ua: navigator.userAgent };
    if (STATE.displayCode) { params.c = STATE.displayCode; }
    if (coords) { params.lat = coords.lat; params.lng = coords.lng; }
    return apiGet(params);
  })
    .then(function (res) {
      STATE.busy = false;
      setButtonLoading(el.btnStart, false, TEXT.start);
      if (res && res.ok && res.token) {
        STATE.token = res.token;
        hideBanner();
        goToPin();
      } else if (res && res.result === 'qr_required') {
        showQrRequired();
      } else {
        showStartFailure();
      }
    })
    .catch(function () {
      STATE.busy = false;
      setButtonLoading(el.btnStart, false, TEXT.start);
      // ネットワーク不通 → 起動失敗（B1 §5-5）。オフラインなら offline 表示。
      if (!navigator.onLine) {
        showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
      } else {
        showStartFailure();
      }
    });
}

function goToPin() {
  resetPinState();
  showScreen('pin');
  el.pinError.textContent = '';
}

// =============================================================================
// Screen 2: PIN Entry
// =============================================================================
function onKeypadClick(e) {
  var btn = e.target.closest('.key');
  if (!btn) { return; }
  if (btn.dataset.action === 'delete') {
    deletePinDigit();
  } else if (btn.dataset.key != null) {
    appendPinDigit(btn.dataset.key);
  }
}

function onPhysicalKey(e) {
  if (!el.screenPin.classList.contains('is-active')) { return; }
  if (e.key >= '0' && e.key <= '9') {
    appendPinDigit(e.key);
  } else if (e.key === 'Backspace') {
    deletePinDigit();
  } else if (e.key === 'Enter' && !el.btnContinue.disabled) {
    onContinue();
  }
}

function appendPinDigit(d) {
  clearPinError();
  if (STATE.pin.length >= PIN_LENGTH) { return; }
  STATE.pin += d;
  renderPinDots();
  // B1：最終桁入力での自動送信はしない（誤確定防止）。Continue は明示押下。
  el.btnContinue.disabled = (STATE.pin.length !== PIN_LENGTH);
}

function deletePinDigit() {
  clearPinError();
  STATE.pin = STATE.pin.slice(0, -1);
  renderPinDots();
  el.btnContinue.disabled = (STATE.pin.length !== PIN_LENGTH);
}

function renderPinDots() {
  var dots = el.pinDots.querySelectorAll('.pin__dot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].classList.toggle('is-filled', i < STATE.pin.length);
  }
  // 表示トグルON時の数字（マスク解除）
  el.pinShown.textContent = STATE.pin.replace(/./g, function (c) { return c; });
}

function onTogglePin() {
  var showing = el.screenPin.classList.toggle('is-show');
  el.pinToggle.textContent = showing ? 'Hide' : 'Show';
  el.pinToggle.setAttribute('aria-pressed', showing ? 'true' : 'false');
}

function resetPinState() {
  STATE.pin = '';
  renderPinDots();
  el.btnContinue.disabled = true;
  el.screenPin.classList.remove('is-error', 'is-shake', 'is-show');
  el.pinToggle.textContent = 'Show';
  el.pinToggle.setAttribute('aria-pressed', 'false');
}

function clearPinError() {
  el.pinError.textContent = '';
  el.screenPin.classList.remove('is-error');
}

function showPinError(message) {
  el.pinError.textContent = message;
  el.screenPin.classList.add('is-error', 'is-shake');
  // シェイクは一回限り（クラス除去で再付与可能に）
  setTimeout(function () { el.screenPin.classList.remove('is-shake'); }, 200);
  // 入力をクリアして即再入力可（B1 §5-2）
  STATE.pin = '';
  renderPinDots();
  el.btnContinue.disabled = true;
}

function onContinue() {
  if (STATE.busy) { return; }
  if (STATE.pin.length !== PIN_LENGTH) { return; }
  if (!navigator.onLine) {
    showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
    return;
  }
  if (!STATE.token) {
    // トークン未取得（滞在が長く失効など）→ 起動からやり直し
    showStartFailure();
    return;
  }

  setButtonLoading(el.btnContinue, true, TEXT.continueLabel);
  STATE.busy = true;

  apiPost({
    action: 'verifyPin',
    token: STATE.token,
    pin: STATE.pin,
    ua: navigator.userAgent
  })
    .then(function (res) {
      STATE.busy = false;
      setButtonLoading(el.btnContinue, false, TEXT.continueLabel);

      if (res && res.ok) {
        STATE.employeeId = res.employeeId;
        STATE.employeeName = res.employeeName;
        STATE.lastPunch = res.lastPunch || null;
        goToAction();
        return;
      }

      // 失敗：ロック or PIN誤り（どの桁が違うかは出さない・B1 §5-2）
      if (res && res.result === 'locked') {
        var sec = res.lockSeconds || 60;
        showPinError(TEXT.pinLocked.replace('{s}', sec));
        el.btnContinue.disabled = true;
      } else {
        showPinError(TEXT.pinIncorrect);
      }
    })
    .catch(function () {
      STATE.busy = false;
      setButtonLoading(el.btnContinue, false, TEXT.continueLabel);
      if (!navigator.onLine) {
        showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
      } else {
        // サーバ到達不可。PIN誤りと混同させず一般エラーをResultで見せる。
        showRejectResult('serverError');
      }
    });
}

// =============================================================================
// Screen 3: Action Select
// =============================================================================
function goToAction() {
  // 氏名・ID（B1 §3）
  el.actionHello.textContent = 'Hello, ' + (STATE.employeeName || '');
  el.actionEmpId.textContent = STATE.employeeId || '';

  // 選択リセット
  STATE.selectedType = null;
  el.choiceIn.classList.remove('is-selected');
  el.choiceOut.classList.remove('is-selected');
  el.choiceIn.setAttribute('aria-pressed', 'false');
  el.choiceOut.setAttribute('aria-pressed', 'false');
  el.btnPunch.disabled = true;
  setPunchLabel();

  // 直近打刻の予防表示（二重打刻の気づき・B1 §3）
  el.choiceIn.classList.remove('has-warn');
  el.choiceOut.classList.remove('has-warn');
  el.choiceInWarn.textContent = '';
  el.choiceOutWarn.textContent = '';
  el.actionLast.textContent = '';

  if (STATE.lastPunch && STATE.lastPunch.type) {
    var t = STATE.lastPunch.timeDisplay || '';
    var typeLabel = STATE.lastPunch.type === 'in' ? 'In' : 'Out';
    el.actionLast.textContent = TEXT.lastPunch.replace('{type}', typeLabel).replace('{time}', t);
    if (STATE.lastPunch.type === 'in') {
      el.choiceIn.classList.add('has-warn');
      el.choiceInWarn.textContent = TEXT.alreadyIn.replace('{time}', t);
    } else if (STATE.lastPunch.type === 'out') {
      el.choiceOut.classList.add('has-warn');
      el.choiceOutWarn.textContent = TEXT.alreadyOut.replace('{time}', t);
    }
  }

  showScreen('action');
}

function selectType(type) {
  STATE.selectedType = type;
  var isIn = type === 'in';
  el.choiceIn.classList.toggle('is-selected', isIn);
  el.choiceOut.classList.toggle('is-selected', !isIn);
  el.choiceIn.setAttribute('aria-pressed', isIn ? 'true' : 'false');
  el.choiceOut.setAttribute('aria-pressed', isIn ? 'false' : 'true');
  el.btnPunch.disabled = false;
  setPunchLabel();
}

function setPunchLabel() {
  var label = STATE.selectedType === 'in' ? TEXT.punchIn
    : STATE.selectedType === 'out' ? TEXT.punchOut
      : TEXT.punch;
  el.btnPunch.querySelector('.btn__label').textContent = label;
}

function onPunch() {
  if (STATE.busy) { return; } // 二重送信の最終ガード
  if (!STATE.selectedType) { return; }
  if (!navigator.onLine) {
    // 打刻はサーバ記録が正＝オフラインでは不成立（B1 §5-4）。成功と誤認させない。
    showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
    return;
  }
  if (!STATE.token) {
    showRejectResult('tokenExpired');
    return;
  }

  // 即時に二重無効化（送信中＝二重打刻の物理的防止・B1 §3/§4）
  STATE.busy = true;
  setButtonLoading(el.btnPunch, true, TEXT.submitting);
  el.btnCancel.disabled = true;

  var punchPayload = {
    action: 'punch',
    token: STATE.token,
    employeeId: STATE.employeeId,
    type: STATE.selectedType,
    ua: navigator.userAgent
  };
  if (STATE.geo) { punchPayload.lat = STATE.geo.lat; punchPayload.lng = STATE.geo.lng; }

  apiPost(punchPayload)
    .then(function (res) {
      STATE.busy = false;
      el.btnCancel.disabled = false;
      setButtonLoading(el.btnPunch, false, null);
      // 使い切ったトークンは破棄（再打刻は再QR）
      STATE.token = null;
      handlePunchResponse(res);
    })
    .catch(function () {
      STATE.busy = false;
      el.btnCancel.disabled = false;
      setButtonLoading(el.btnPunch, false, null);
      STATE.token = null;
      if (!navigator.onLine) {
        // 送信中に切断 → 結果不明だが「未記録扱い」を明示（曖昧にしない）
        showBanner(TEXT.offlineTitle, TEXT.offlineMsg);
        showRejectResult('serverError');
      } else {
        showRejectResult('serverError');
      }
    });
}

function handlePunchResponse(res) {
  if (!res) {
    showRejectResult('serverError');
    return;
  }
  if (res.ok && res.result === 'success') {
    showSuccessResult(res);
    return;
  }
  if (res.ok && res.result === 'flagged') {
    showFlaggedResult(res);
    return;
  }
  // 拒否系（rejected/token_expired/token_reused/error）
  switch (res.result) {
    case 'rejected':
      showRejectResult('duplicate', res);
      break;
    case 'token_expired':
      showRejectResult('tokenExpired');
      break;
    case 'token_reused':
      showRejectResult('tokenReused');
      break;
    case 'too_far':
      showRejectResult('tooFar');
      break;
    default:
      showRejectResult('serverError');
  }
}

// =============================================================================
// Screen 4: Result
// =============================================================================
function showSuccessResult(res) {
  setResultVariant('success');
  setResultIcon('check');
  var title = res.type === 'in' ? TEXT.successInTitle : TEXT.successOutTitle;
  setResultTitle(title);
  el.resultWho.textContent = (STATE.employeeName || '') + ' · ' + (STATE.employeeId || '');
  el.resultTime.textContent = res.serverTimeDisplay || '';
  el.resultServerNote.textContent = TEXT.serverNote; // 「Recorded on the server」
  el.resultHelpBlock.hidden = true;

  announce('Punched ' + (res.type === 'in' ? 'in' : 'out') +
    ' successfully at ' + (res.serverTimeDisplay || ''));

  showScreen('result-success');
  startAutoReturn();
}

function showFlaggedResult(res) {
  // 記録はされたが要確認（脅し文句にしない・B1 §4-c）
  setResultVariant('warning');
  setResultIcon('flag');
  setResultTitle(TEXT.flaggedTitle);
  el.resultWho.textContent = (STATE.employeeName || '') + ' · ' + (STATE.employeeId || '');
  el.resultTime.textContent = res.serverTimeDisplay || '';
  el.resultServerNote.textContent = TEXT.flaggedMsg;
  el.resultHelpBlock.hidden = false;
  el.resultTodo.textContent = TEXT.flaggedTodo;

  announce(TEXT.flaggedMsg);
  // 記録はされたので Done（success フッタ）を出す
  showScreen('result-success');
  startAutoReturn();
}

/**
 * 拒否・期限切れ・再利用・サーバエラーの結果表示。
 * @param {string} reason 'duplicate'|'tokenExpired'|'tokenReused'|'serverError'
 * @param {Object} [res]  サーバ応答（duplicate のメッセージ差し込み用）
 */
function showRejectResult(reason, res) {
  el.resultHelpBlock.hidden = false;
  el.resultWho.textContent = '';
  el.resultTime.textContent = '';
  el.resultServerNote.textContent = '';

  switch (reason) {
    case 'duplicate':
      setResultVariant('warning');
      setResultIcon('warn');
      setResultTitle(TEXT.rejectDupTitle);
      el.resultServerNote.textContent = (res && res.message) ? res.message : 'You already punched today.';
      el.resultTodo.textContent = TEXT.rejectDupTodo;
      break;
    case 'tokenExpired':
      setResultVariant('warning');
      setResultIcon('warn');
      setResultTitle(TEXT.tokenExpiredTitle);
      el.resultServerNote.textContent = TEXT.tokenExpiredMsg;
      el.resultTodo.textContent = TEXT.tokenExpiredTodo;
      break;
    case 'tokenReused':
      setResultVariant('danger');
      setResultIcon('warn');
      setResultTitle(TEXT.tokenReusedTitle);
      el.resultServerNote.textContent = TEXT.tokenReusedMsg;
      el.resultTodo.textContent = TEXT.tokenReusedTodo;
      break;
    case 'tooFar':
      setResultVariant('warning');
      setResultIcon('warn');
      setResultTitle(TEXT.tooFarTitle);
      el.resultServerNote.textContent = TEXT.tooFarMsg;
      el.resultTodo.textContent = TEXT.tooFarTodo;
      break;
    case 'serverError':
    default:
      setResultVariant('danger');
      setResultIcon('warn');
      setResultTitle(TEXT.serverErrTitle);
      el.resultServerNote.textContent = TEXT.serverErrMsg;
      el.resultTodo.textContent = TEXT.serverErrTodo;
  }

  announce(el.resultTitle.textContent + '. ' + el.resultServerNote.textContent);
  showScreen('result-reject');
}

function showStartFailure() {
  // トークン未取得（B1 §5-5）。Result の reject パターンで再QRを促す。
  setResultVariant('danger');
  setResultIcon('warn');
  setResultTitle(TEXT.startFailTitle);
  el.resultWho.textContent = '';
  el.resultTime.textContent = '';
  el.resultServerNote.textContent = TEXT.startFailMsg;
  el.resultHelpBlock.hidden = false;
  el.resultTodo.textContent = TEXT.startFailTodo;
  announce(TEXT.startFailTitle + '. ' + TEXT.startFailMsg);
  showScreen('result-reject');
}

// 現場QR必須なのに c が無い/失効（保存QR・直接アクセス）。パッドの生QRを促す。
function showQrRequired() {
  setResultVariant('warning');
  setResultIcon('warn');
  setResultTitle(TEXT.qrRequiredTitle);
  el.resultWho.textContent = '';
  el.resultTime.textContent = '';
  el.resultServerNote.textContent = TEXT.qrRequiredMsg;
  el.resultHelpBlock.hidden = false;
  el.resultTodo.textContent = TEXT.qrRequiredTodo;
  announce(TEXT.qrRequiredTitle + '. ' + TEXT.qrRequiredMsg);
  showScreen('result-reject');
}

function setResultVariant(variant) {
  el.screenResult.classList.remove('result--success', 'result--warning', 'result--danger');
  el.screenResult.classList.add('result--' + variant);
}

function setResultTitle(text) {
  // 改行（\n）を <br> 相当で見せる（display 2行の成功見出し）
  el.resultTitle.textContent = '';
  var parts = String(text).split('\n');
  parts.forEach(function (line, idx) {
    if (idx > 0) { el.resultTitle.appendChild(document.createElement('br')); }
    el.resultTitle.appendChild(document.createTextNode(line));
  });
}

// アイコン差し替え（線アイコン・stroke 2px方針）
function setResultIcon(kind) {
  var paths = {
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line>'
  };
  el.resultIcon.innerHTML = paths[kind] || paths.check;
}

// =============================================================================
// Result フッタの操作
// =============================================================================
function onTryAgain() {
  // 期限切れ/再利用/起動失敗は再QRが本筋だが、UIからは再起動（Welcome）に戻す。
  resetToWelcome();
}

function onGetHelp() {
  // B1未確定事項4：HR連絡導線。MVPは簡易案内（Telegram/電話は運用確定後に差し込み）。
  announce('Please contact HR for help.');
  el.resultTodo.textContent = 'Please contact HR (front office) for help.';
}

function startAutoReturn() {
  clearAutoReturn();
  if (!CONFIG.AUTO_RETURN_SECONDS || CONFIG.AUTO_RETURN_SECONDS <= 0) {
    el.resultReturn.textContent = '';
    return;
  }
  var remaining = CONFIG.AUTO_RETURN_SECONDS;
  el.resultReturn.textContent = TEXT.returning.replace('{s}', remaining);
  STATE.autoReturnTimer = setInterval(function () {
    remaining -= 1;
    if (remaining <= 0) {
      clearAutoReturn();
      resetToWelcome();
      return;
    }
    el.resultReturn.textContent = TEXT.returning.replace('{s}', remaining);
  }, 1000);
}

function clearAutoReturn() {
  if (STATE.autoReturnTimer) {
    clearInterval(STATE.autoReturnTimer);
    STATE.autoReturnTimer = null;
  }
  el.resultReturn.textContent = '';
}

// =============================================================================
// 初期化（再打刻は再QR＝新トークン。トークンは破棄）
// =============================================================================
function resetToWelcome() {
  clearAutoReturn();
  STATE.token = null;
  STATE.pin = '';
  STATE.employeeId = null;
  STATE.employeeName = null;
  STATE.lastPunch = null;
  STATE.selectedType = null;
  STATE.busy = false;
  resetPinState();
  el.btnCancel.disabled = false;
  showScreen('welcome');
}

// =============================================================================
// API 呼び出し（text/plain POST でプリフライト回避・B1）
// =============================================================================

/**
 * GET（クエリパラメータ）。トークン発行などGAS doGet 用。
 */
function apiGet(params) {
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = CONFIG.API_URL + (CONFIG.API_URL.indexOf('?') >= 0 ? '&' : '?') + qs;

  return fetchWithTimeout(url, { method: 'GET' }).then(parseJson);
}

/**
 * POST。本文は JSON 文字列だが Content-Type は text/plain にする（プリフライト回避）。
 */
function apiPost(payload) {
  return fetchWithTimeout(CONFIG.API_URL, {
    method: 'POST',
    // ★ application/json にしない（OPTIONS プリフライトを誘発するため）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    // GAS は redirect を返すことがある（follow が既定で必要）
    redirect: 'follow'
  }).then(parseJson);
}

function fetchWithTimeout(url, options) {
  // AbortController で遅延打ち切り。SLOW_HINT_MS で「まだ処理中」を出す。
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (controller) { options.signal = controller.signal; }

  var slowTimer = setTimeout(showSlowHint, CONFIG.SLOW_HINT_MS);
  var timeoutTimer = setTimeout(function () {
    if (controller) { controller.abort(); }
  }, CONFIG.REQUEST_TIMEOUT_MS);

  return fetch(url, options).then(function (resp) {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    return resp;
  }).catch(function (err) {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    throw err;
  });
}

function parseJson(resp) {
  if (!resp || !resp.ok) {
    // 5xx 等。サーバエラーとして扱う（B1 §4-c）。
    throw new Error('HTTP ' + (resp ? resp.status : 'no-response'));
  }
  return resp.text().then(function (txt) {
    try {
      return JSON.parse(txt);
    } catch (e) {
      throw new Error('Bad JSON');
    }
  });
}

function showSlowHint() {
  // 3秒超で「まだ処理中」を該当ボタンに反映（不安にさせない・B1 §4）
  [el.btnStart, el.btnContinue, el.btnPunch].forEach(function (btn) {
    if (btn.classList.contains('is-loading')) {
      var label = btn.querySelector('.btn__label');
      if (label) { label.textContent = 'Still working…'; }
    }
  });
}

// =============================================================================
// UIヘルパ
// =============================================================================
function setButtonLoading(btn, loading, label) {
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
  var labelEl = btn.querySelector('.btn__label');
  if (labelEl && label != null) {
    labelEl.textContent = label;
  }
}

function showBanner(title, msg) {
  el.bannerTitle.textContent = title;
  el.bannerMsg.textContent = msg;
  el.offlineBanner.classList.add('is-visible');
}

function hideBanner() {
  el.offlineBanner.classList.remove('is-visible');
}

function announce(text) {
  // ライブリージョンへ（読み上げ）。一度クリアしてから入れて再通知を保証。
  el.liveRegion.textContent = '';
  setTimeout(function () { el.liveRegion.textContent = text; }, 30);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}
