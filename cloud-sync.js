(() => {
  'use strict';

  const config = window.CALHAPRO_SUPABASE;
  const SESSION_KEY = 'calhapro_cloud_session_v1';
  const OWNER_KEY = 'calhapro_cloud_owner_v1';
  const BACKUP_KEY = 'calhapro_cloud_migration_backup_v1';
  const DATA_KEY = 'calhapro_v1';
  const SYNC_TABLE = 'calhapro_cloud_data';
  const SYNC_FUNCTION = 'calhapro_save_data';
  const LIST_KEYS = ['clients', 'quotes', 'receipts', 'catalog', 'visits', 'productionOrders', 'stockItems', 'stockMoves', 'installations', 'invoiceRecords', 'transactions', 'warrantyCalls'];

  let session = readJson(SESSION_KEY);
  let revision = 0;
  let dirty = false;
  let saveTimer = 0;
  let syncBusy = false;
  let syncAgain = false;
  let pendingConflict = null;
  let basePayload = null;
  let panel;

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    }
    return value;
  }

  function same(a, b) {
    return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  }

  function emptyData() {
    const data = { clients: [], quotes: [], company: {}, receipts: [] };
    for (const key of LIST_KEYS) if (!Array.isArray(data[key])) data[key] = [];
    return data;
  }

  function normalize(payload) {
    const data = { ...emptyData(), ...(payload && typeof payload === 'object' ? payload : {}) };
    for (const key of LIST_KEYS) if (!Array.isArray(data[key])) data[key] = [];
    if (!data.company || typeof data.company !== 'object' || Array.isArray(data.company)) data.company = {};
    return data;
  }

  function hasData(data) {
    if (!data || typeof data !== 'object') return false;
    return Object.keys(data).some(key => Array.isArray(data[key]) ? data[key].length > 0 : key === 'company' && Object.keys(data.company || {}).length > 0);
  }

  function entityMap(items) {
    const map = new Map();
    for (const item of items || []) {
      const key = item && item.id != null ? String(item.id) : JSON.stringify(stable(item));
      map.set(key, item);
    }
    return map;
  }

  function mergeInitial(localData, cloudData) {
    const local = normalize(localData);
    const cloud = normalize(cloudData);
    const merged = { ...local, ...cloud, company: { ...local.company, ...cloud.company } };
    for (const key of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
      if (!Array.isArray(local[key]) && !Array.isArray(cloud[key])) continue;
      const rows = entityMap(cloud[key]);
      for (const [id, value] of entityMap(local[key])) if (!rows.has(id)) rows.set(id, value);
      merged[key] = [...rows.values()];
    }
    return normalize(merged);
  }

  function threeWayMerge(baseData, localData, cloudData, prefer = 'cloud') {
    const base = normalize(baseData);
    const local = normalize(localData);
    const cloud = normalize(cloudData);
    const merged = { ...cloud };
    const conflicts = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(cloud)]);

    for (const key of keys) {
      if (key === 'company' || Array.isArray(base[key]) || Array.isArray(local[key]) || Array.isArray(cloud[key])) continue;
      const b = base[key], l = local[key], c = cloud[key];
      const localChanged = !same(l, b), cloudChanged = !same(c, b);
      if (localChanged && cloudChanged && !same(l, c)) {
        conflicts.push(key);
        merged[key] = prefer === 'local' ? l : c;
      } else merged[key] = localChanged ? l : c;
    }

    const company = {};
    const companyKeys = new Set([...Object.keys(base.company), ...Object.keys(local.company), ...Object.keys(cloud.company)]);
    for (const key of companyKeys) {
      const b = base.company[key], l = local.company[key], c = cloud.company[key];
      const localChanged = !same(l, b), cloudChanged = !same(c, b);
      if (localChanged && cloudChanged && !same(l, c)) {
        conflicts.push('company.' + key);
        if (prefer === 'local' ? l !== undefined : c !== undefined) company[key] = prefer === 'local' ? l : c;
      } else {
        const value = localChanged ? l : c;
        if (value !== undefined) company[key] = value;
      }
    }
    merged.company = company;

    for (const key of keys) {
      if (!(Array.isArray(base[key]) || Array.isArray(local[key]) || Array.isArray(cloud[key]))) continue;
      const b = entityMap(base[key]), l = entityMap(local[key]), c = entityMap(cloud[key]);
      const result = new Map();
      for (const id of new Set([...b.keys(), ...l.keys(), ...c.keys()])) {
        const bv = b.get(id), lv = l.get(id), cv = c.get(id);
        const localExists = l.has(id), cloudExists = c.has(id), baseExists = b.has(id);
        const localChanged = localExists !== baseExists || (localExists && !same(lv, bv));
        const cloudChanged = cloudExists !== baseExists || (cloudExists && !same(cv, bv));
        if (localChanged && cloudChanged && !(localExists === cloudExists && same(lv, cv))) {
          conflicts.push(key + ':' + id);
          const useLocal = prefer === 'local';
          if (useLocal ? localExists : cloudExists) result.set(id, useLocal ? lv : cv);
        } else if (localChanged) {
          if (localExists) result.set(id, lv);
        } else if (cloudExists) result.set(id, cv);
      }
      merged[key] = [...result.values()];
    }
    return { data: normalize(merged), conflicts };
  }

  function sessionUrl(path) { return config.url.replace(/\/+$/, '') + path; }
  function sessionHeaders(token = '') {
    const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  async function readResponse(response) {
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const message = body?.msg || body?.message || body?.hint || body?.error_description || body?.error || ('HTTP ' + response.status);
      throw new Error(String(message));
    }
    return body;
  }

  function storeSession(value) {
    const expiresAt = value.expires_at || Math.floor(Date.now() / 1000) + (+value.expires_in || 3600);
    session = {
      access_token: value.access_token,
      refresh_token: value.refresh_token,
      expires_at: expiresAt,
      user: value.user || session?.user
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async function authRequest(path, body) {
    const response = await fetch(sessionUrl('/auth/v1/' + path), {
      method: 'POST', headers: sessionHeaders(), body: JSON.stringify(body)
    });
    return readResponse(response);
  }

  async function refreshSession() {
    if (!session?.refresh_token) throw new Error('Sua sessão terminou. Entre novamente para sincronizar.');
    if (+session.expires_at > Math.floor(Date.now() / 1000) + 60) return session;
    try {
      const result = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      storeSession(result);
      return session;
    } catch (error) {
      session = null;
      localStorage.removeItem(SESSION_KEY);
      throw error;
    }
  }

  async function authorizedFetch(path, init = {}) {
    await refreshSession();
    const headers = { ...sessionHeaders(session.access_token), ...(init.headers || {}) };
    const response = await fetch(sessionUrl(path), { ...init, headers });
    if (response.status === 401 && session?.refresh_token) {
      session.expires_at = 0;
      await refreshSession();
      return fetch(sessionUrl(path), { ...init, headers: { ...sessionHeaders(session.access_token), ...(init.headers || {}) } });
    }
    return response;
  }

  function baseKey() { return 'calhapro_cloud_base_v1_' + (session?.user?.id || ''); }
  function readBase() { return readJson(baseKey()); }
  function saveBase(payload) {
    basePayload = normalize(payload);
    localStorage.setItem(baseKey(), JSON.stringify(basePayload));
  }

  function rawPersist() {
    localStorage.setItem(DATA_KEY, JSON.stringify(db));
  }

  function saveMigrationBackup(payload) {
    if (!hasData(payload)) return;
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ createdAt: new Date().toISOString(), payload }));
    const button = document.getElementById('cloudDownloadBackup');
    if (button) button.hidden = false;
  }

  function downloadJson(filename, value) {
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    link.href = objectUrl;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function readCloudRow() {
    const userId = encodeURIComponent(session.user.id);
    const response = await authorizedFetch('/rest/v1/' + SYNC_TABLE + '?select=user_id,payload,revision,updated_at&user_id=eq.' + userId);
    const rows = await readResponse(response);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function saveCloud(payload, expectedRevision) {
    const response = await authorizedFetch('/rest/v1/rpc/' + SYNC_FUNCTION, {
      method: 'POST', body: JSON.stringify({ p_expected_revision: expectedRevision, p_payload: payload })
    });
    const result = await readResponse(response);
    return Array.isArray(result) ? result[0] : result;
  }

  function setStatus(message, state = 'info') {
    const element = document.getElementById('cloudSyncStatus');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = state;
  }

  function renderPanel() {
    if (!panel) return;
    const signedIn = Boolean(session?.access_token && session?.user?.id);
    const login = document.getElementById('cloudLoginFields');
    const active = document.getElementById('cloudActiveActions');
    const email = document.getElementById('cloudEmail');
    const backupButton = document.getElementById('cloudDownloadBackup');
    if (login) login.hidden = signedIn;
    if (active) active.hidden = !signedIn;
    if (email && signedIn) email.value = session.user.email || '';
    if (backupButton) backupButton.hidden = !localStorage.getItem(BACKUP_KEY);
    const conflict = document.getElementById('cloudConflictControls');
    if (conflict) conflict.hidden = !pendingConflict;
  }

  function mountPanel() {
    const heading = document.querySelector('#company .heading');
    if (!heading || document.getElementById('cloudSyncPanel')) return;
    heading.insertAdjacentHTML('afterend', `
      <section id="cloudSyncPanel" class="card form cloud-sync-panel">
        <div class="cloud-sync-heading"><div><h2>Sincronização entre dispositivos</h2><p>Use o mesmo acesso no computador e no celular para manter clientes e orçamentos alinhados.</p></div><span class="cloud-sync-mark">⇅</span></div>
        <div id="cloudSyncStatus" class="cloud-sync-status" role="status" aria-live="polite">Configure uma conta para ativar a sincronização.</div>
        <div id="cloudLoginFields" class="grid cloud-sync-grid">
          <div class="field"><label for="cloudEmail">E-mail</label><input id="cloudEmail" type="email" autocomplete="username" placeholder="voce@empresa.com"></div>
          <div class="field"><label for="cloudPassword">Senha</label><input id="cloudPassword" type="password" autocomplete="current-password" placeholder="No mínimo 8 caracteres"></div>
          <div class="cloud-sync-actions full"><button type="button" class="btn" onclick="calhaCreateCloudAccount()">Criar acesso</button><button type="button" class="btn red" onclick="calhaLoginCloudAccount()">Entrar e sincronizar</button></div>
        </div>
        <div id="cloudActiveActions" class="cloud-sync-actions" hidden><button type="button" class="btn red" onclick="calhaSyncNow()">Sincronizar agora</button><button type="button" class="btn" onclick="calhaLogoutCloud()">Sair deste dispositivo</button><button type="button" class="btn" id="cloudDownloadBackup" onclick="calhaDownloadLocalBackup()" hidden>Baixar cópia local de migração</button></div>
        <div id="cloudConflictControls" class="cloud-conflict" hidden><b>Há alterações diferentes entre este aparelho e a nuvem.</b><p>As alterações locais continuam salvas. Baixe uma cópia antes de escolher como resolver o conflito.</p><div class="cloud-sync-actions"><button type="button" class="btn" onclick="calhaDownloadLocalBackup()">Baixar cópia local</button><button type="button" class="btn" onclick="calhaUseCloudVersion()">Usar versão da nuvem</button><button type="button" class="btn red" onclick="calhaMergeKeepLocal()">Mesclar e priorizar este aparelho</button></div></div>
        <small class="muted cloud-sync-footnote">Os dados continuam guardados localmente e são sincronizados quando houver conexão. Use uma senha exclusiva e mantenha os backups.</small>
      </section>`);
    panel = document.getElementById('cloudSyncPanel');
    renderPanel();
  }

  function explainError(error) {
    const text = String(error?.message || error || 'Erro inesperado.');
    if (/calhapro_cloud_data|calhapro_save_data|schema cache|does not exist|could not find/i.test(text)) {
      return 'A tabela segura ainda não foi criada. Execute o arquivo supabase/schema.sql no SQL Editor do Supabase e tente novamente.';
    }
    if (/invalid login|invalid email or password|credentials/i.test(text)) return 'E-mail ou senha não conferem.';
    if (/email not confirmed/i.test(text)) return 'Confirme o e-mail enviado pelo Supabase antes de entrar.';
    return text;
  }

  async function completeLogin(authResult) {
    if (!authResult?.access_token) {
      setStatus('Conta criada. Confira sua caixa de entrada para confirmar o e-mail e depois entre no app.', 'success');
      return;
    }
    storeSession(authResult);
    const previousOwner = localStorage.getItem(OWNER_KEY);
    if (previousOwner && previousOwner !== session.user.id) {
      saveMigrationBackup(db);
      db = emptyData();
      rawPersist();
      basePayload = null;
    }
    localStorage.setItem(OWNER_KEY, session.user.id);
    pendingConflict = null;
    dirty = false;
    renderPanel();
    setStatus('Acessando os dados protegidos da conta…');
    await hydrateCloud();
  }

  async function createAccount() {
    const email = document.getElementById('cloudEmail')?.value.trim();
    const password = document.getElementById('cloudPassword')?.value || '';
    if (!email || password.length < 8) return setStatus('Informe um e-mail válido e uma senha com pelo menos 8 caracteres.', 'error');
    setStatus('Criando acesso…');
    try {
      const result = await authRequest('signup', { email, password });
      await completeLogin(result);
    } catch (error) { setStatus(explainError(error), 'error'); }
  }

  async function login() {
    const email = document.getElementById('cloudEmail')?.value.trim();
    const password = document.getElementById('cloudPassword')?.value || '';
    if (!email || !password) return setStatus('Informe o e-mail e a senha da conta.', 'error');
    setStatus('Entrando e carregando dados…');
    try {
      const result = await authRequest('token?grant_type=password', { email, password });
      await completeLogin(result);
    } catch (error) { setStatus(explainError(error), 'error'); }
  }

  function updateActiveView() {
    const active = document.querySelector('.page.on')?.id;
    if (active === 'home') dashboard();
    else if (active === 'quotes') renderQuotes();
    else if (active === 'clients') renderClients();
    else if (active === 'receipts') renderReceipts();
    else if (active === 'sales') renderPipeline();
    else if (active === 'company') renderCompany();
    else if (active === 'detail' && current) showQuote(current);
    else if (active === 'receiptDetail' && currentReceipt) showReceipt(currentReceipt);
    if (typeof addCompanySignatureToQuote === 'function' && active === 'detail') addCompanySignatureToQuote();
  }

  function applyCloudPayload(payload, rowRevision) {
    db = normalize(payload);
    rawPersist();
    revision = +rowRevision || 0;
    saveBase(db);
    dirty = false;
    pendingConflict = null;
    renderPanel();
    updateActiveView();
  }

  function setConflict(row, message = 'Outro aparelho salvou dados mais recentes. Escolha como resolver para continuar a sincronização.') {
    pendingConflict = row;
    dirty = true;
    renderPanel();
    setStatus(message, 'conflict');
  }

  async function hydrateCloud() {
    try {
      const local = normalize(db);
      const oldBase = readBase();
      const remote = await readCloudRow();
      if (!remote) {
        if (hasData(local)) { saveMigrationBackup(local); renderPanel(); }
        const saved = await saveCloud(local, 0);
        if (!saved?.saved) {
          setConflict({ revision: saved?.revision || 0, payload: normalize(saved?.payload) });
          return;
        }
        applyCloudPayload(local, saved.revision);
        setStatus('Sincronização ativada. Este aparelho enviou os dados existentes para a conta.', 'success');
        return;
      }

      let merged;
      let conflicts = [];
      if (oldBase) {
        const result = threeWayMerge(oldBase, local, remote.payload, 'cloud');
        merged = result.data;
        conflicts = result.conflicts;
      } else {
        if (hasData(local)) { saveMigrationBackup(local); renderPanel(); }
        merged = mergeInitial(local, remote.payload);
      }
      if (conflicts.length) {
        setConflict(remote, 'Há registros editados nos dois aparelhos. A cópia local foi preservada; baixe um backup e escolha uma versão.');
        return;
      }

      if (!same(merged, remote.payload)) {
        const saved = await saveCloud(merged, +remote.revision || 0);
        if (!saved?.saved) {
          setConflict({ revision: saved?.revision || 0, payload: normalize(saved?.payload) });
          return;
        }
        applyCloudPayload(merged, saved.revision);
        setStatus('Sincronização ativada. Os dados locais e da nuvem foram combinados.', 'success');
      } else {
        applyCloudPayload(remote.payload, remote.revision);
        setStatus('Sincronizado com a nuvem · ' + (session.user.email || 'conta CalhaPro'), 'success');
      }
    } catch (error) {
      setStatus(explainError(error), 'error');
    }
  }

  function isEditing() {
    if (document.querySelector('#editor.page.on, #receiptEditor.page.on')) return true;
    return document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  }

  async function syncNow() {
    if (!session?.access_token) return setStatus('Entre na conta para sincronizar.', 'error');
    if (!navigator.onLine) return setStatus('Sem internet. As alterações continuam salvas neste aparelho e serão enviadas quando a conexão voltar.', 'offline');
    if (syncBusy) { syncAgain = true; return; }
    if (pendingConflict) return setStatus('Resolva o conflito acima antes de sincronizar novamente.', 'conflict');
    syncBusy = true;
    try {
      const remote = await readCloudRow();
      if (!remote) {
        const saved = await saveCloud(normalize(db), 0);
        if (!saved?.saved) setConflict({ revision: saved?.revision || 0, payload: normalize(saved?.payload) });
        else {
          revision = +saved.revision || 0;
          saveBase(db);
          dirty = false;
          setStatus('Sincronizado agora.', 'success');
        }
        return;
      }

      if ((+remote.revision || 0) !== revision) {
        if (!dirty && !isEditing()) {
          applyCloudPayload(remote.payload, remote.revision);
          setStatus('Dados atualizados com a versão mais recente da nuvem.', 'success');
          return;
        }
        const result = threeWayMerge(basePayload || readBase(), db, remote.payload, 'cloud');
        if (result.conflicts.length) {
          saveMigrationBackup(db);
          setConflict(remote);
          return;
        }
        db = result.data;
        rawPersist();
        const saved = await saveCloud(db, +remote.revision || 0);
        if (!saved?.saved) { setConflict({ revision: saved?.revision || 0, payload: normalize(saved?.payload) }); return; }
        revision = +saved.revision || 0;
        saveBase(db);
        dirty = false;
      } else if (dirty) {
        const saved = await saveCloud(normalize(db), revision);
        if (!saved?.saved) { setConflict({ revision: saved?.revision || 0, payload: normalize(saved?.payload) }); return; }
        revision = +saved.revision || 0;
        saveBase(db);
        dirty = false;
      }
      setStatus('Sincronizado agora · ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), 'success');
    } catch (error) {
      setStatus(navigator.onLine ? explainError(error) : 'Sem internet. Os dados continuam salvos neste aparelho.', navigator.onLine ? 'error' : 'offline');
    } finally {
      syncBusy = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }

  function scheduleSync(delay = 900) {
    if (!session?.access_token) return;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void syncNow(); }, delay);
    setStatus(navigator.onLine ? 'Alteração salva neste aparelho; sincronizando…' : 'Salvo neste aparelho. Será sincronizado quando a internet voltar.', navigator.onLine ? 'info' : 'offline');
  }

  function logout() {
    const token = session?.access_token;
    if (token) fetch(sessionUrl('/auth/v1/logout'), { method: 'POST', headers: sessionHeaders(token) }).catch(() => {});
    session = null;
    pendingConflict = null;
    dirty = false;
    localStorage.removeItem(SESSION_KEY);
    renderPanel();
    setStatus('Saiu da conta neste aparelho. Os dados locais não foram apagados.', 'info');
  }

  function downloadLocalBackup() {
    const saved = readJson(BACKUP_KEY);
    downloadJson('calhapro-backup-local-migracao-' + new Date().toISOString().slice(0, 10) + '.json', saved?.payload || db);
  }

  function useCloudVersion() {
    if (!pendingConflict) return;
    saveMigrationBackup(db);
    applyCloudPayload(pendingConflict.payload, pendingConflict.revision);
    setStatus('A versão da nuvem foi carregada. A cópia anterior deste aparelho ficou disponível para baixar.', 'success');
  }

  async function mergeKeepLocal() {
    if (!pendingConflict) return;
    saveMigrationBackup(db);
    const result = threeWayMerge(basePayload || readBase() || emptyData(), db, pendingConflict.payload, 'local');
    db = result.data;
    rawPersist();
    revision = +pendingConflict.revision || 0;
    pendingConflict = null;
    renderPanel();
    setStatus('Mesclando as alterações e priorizando este aparelho…');
    dirty = true;
    await syncNow();
    updateActiveView();
  }

  function installPanelStyles() {
    const style = document.createElement('style');
    style.id = 'cloud-sync-styles';
    style.textContent = `
      #cloudSyncPanel{margin:0 0 14px;padding:18px;border-radius:12px}.cloud-sync-heading{display:flex;justify-content:space-between;align-items:center;gap:14px}.cloud-sync-heading h2{margin:0 0 4px;font-size:16px}.cloud-sync-heading p,.cloud-sync-footnote{margin:0;color:#747780;font-size:11px}.cloud-sync-mark{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:#fff0f1;color:#bb1e2d;font-size:22px;font-weight:800}.cloud-sync-status{margin:14px 0;padding:10px 12px;border-radius:8px;background:#f5f5f6;color:#45484e;font-size:12px}.cloud-sync-status[data-state="success"]{background:#eaf7ef;color:#17603a}.cloud-sync-status[data-state="error"],.cloud-sync-status[data-state="conflict"]{background:#fff0ee;color:#9c2c24}.cloud-sync-status[data-state="offline"]{background:#fff5dd;color:#725700}.cloud-sync-grid{gap:10px}.cloud-sync-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.cloud-sync-actions .btn{min-height:40px}.cloud-sync-footnote{display:block;margin-top:13px}.cloud-conflict{margin-top:14px;padding:13px;border:1px solid #e8b5b7;border-radius:9px;background:#fff8f7}.cloud-conflict>b{font-size:12px;color:#8b2029}.cloud-conflict>p{font-size:11px;color:#555;margin:5px 0}.cloud-conflict[hidden],#cloudLoginFields[hidden],#cloudActiveActions[hidden]{display:none!important}@media(max-width:640px){#cloudSyncPanel{padding:13px 11px}.cloud-sync-heading h2{font-size:14px}.cloud-sync-actions{display:grid;grid-template-columns:1fr}.cloud-sync-actions .btn{width:100%}}`;
    document.head.appendChild(style);
  }

  window.calhaCreateCloudAccount = createAccount;
  window.calhaLoginCloudAccount = login;
  window.calhaSyncNow = syncNow;
  window.calhaLogoutCloud = logout;
  window.calhaDownloadLocalBackup = downloadLocalBackup;
  window.calhaUseCloudVersion = useCloudVersion;
  window.calhaMergeKeepLocal = mergeKeepLocal;

  mountPanel();
  installPanelStyles();
  const originalPersist = window.persist;
  if (typeof originalPersist === 'function') {
    window.persist = function () {
      originalPersist();
      scheduleSync();
    };
  }

  if (!config?.url || !config?.publishableKey) {
    setStatus('A conexão com a nuvem ainda não foi configurada.', 'error');
  } else if (session?.access_token) {
    localStorage.setItem(OWNER_KEY, session.user?.id || '');
    renderPanel();
    setStatus('Reconectando à conta…');
    void refreshSession().then(hydrateCloud).catch(error => setStatus(explainError(error), 'error'));
  } else {
    renderPanel();
  }

  window.addEventListener('online', () => { if (session?.access_token) void syncNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session?.access_token && !isEditing()) void syncNow();
  });
  setInterval(() => {
    if (session?.access_token && document.visibilityState === 'visible' && !isEditing()) void syncNow();
  }, 60000);
})();

