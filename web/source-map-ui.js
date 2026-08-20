// Índice de fontes do Nexus: carga em lote por projeto.
(() => {
  if (window.__NEXUS_SOURCE_MAP_UI__) return;
  window.__NEXUS_SOURCE_MAP_UI__ = true;

  const TEMPLATE = {
    project: 'listalar',
    name: 'ListaLar',
    aliases: ['lista lar', 'compras-da-casa'],
    sources: [
      {
        id: 'usuarios-auth',
        domain: 'usuarios',
        source: 'firebase_authentication',
        tool: 'firebase_auth_users',
        topics: ['usuarios', 'contas', 'login', 'ultimo acesso', 'inatividade', 'email', 'uid', 'provedor'],
        args: { project: 'listalar', limit: 1000 },
        fields: ['uid', 'email', 'displayName', 'disabled', 'emailVerified', 'creationTime', 'lastSignInTime', 'providerIds'],
        readOnly: true,
        priority: 100
      },
      {
        id: 'status-firebase',
        domain: 'status_firebase',
        source: 'firebase',
        tool: 'firebase_project_status',
        topics: ['status', 'conexao', 'firebase', 'authentication', 'firestore', 'colecoes'],
        args: { project: 'listalar' },
        readOnly: true,
        priority: 90
      },
      {
        id: 'usuarios-firestore',
        domain: 'cadastro_usuario',
        source: 'firestore',
        tool: 'firestore_read',
        topics: ['cadastro do usuario', 'familiaId', 'perfil persistido'],
        paths: ['usuarios/{uid}'],
        args: { project: 'listalar', path: 'usuarios/{uid}', limit: 50 },
        readOnly: true,
        priority: 80
      },
      {
        id: 'familias-gastos',
        domain: 'compras_gastos',
        source: 'firestore',
        tool: 'listalar_spending_analytics',
        topics: ['compras', 'gastos', 'total gasto', 'produtos', 'precos', 'aumentos', 'quedas', 'mercados'],
        paths: ['familias/{familiaId}/gastos/{gastoId}', 'familias/{familiaId}/gastos/{gastoId}/itens/{itemId}'],
        args: { days: 0 },
        readOnly: true,
        priority: 100
      },
      {
        id: 'familias-firestore',
        domain: 'familias',
        source: 'firestore',
        tool: 'firestore_read',
        topics: ['familias', 'membros', 'dados da familia'],
        paths: ['familias/{familiaId}'],
        args: { project: 'listalar', path: 'familias/{familiaId}', limit: 50 },
        readOnly: true,
        priority: 70
      },
      {
        id: 'codigo-listalar',
        domain: 'codigo',
        source: 'github',
        tool: 'github_investigate',
        topics: ['codigo', 'arquivo', 'bug', 'implementacao', 'arquitetura', 'github'],
        repository: 'giva-norberto/ListaLar',
        args: { project: 'listalar' },
        readOnly: true,
        priority: 60
      }
    ]
  };

  const esc = (value) => String(value ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c] || c));

  function normalizeProjectKey(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-');
  }

  function validateEntry(entry, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Item ${index + 1}: objeto de projeto inválido.`);
    const project = normalizeProjectKey(entry.project || entry.key || entry.name);
    if (!project) throw new Error(`Item ${index + 1}: informe project.`);
    if (!Array.isArray(entry.sources) || !entry.sources.length) throw new Error(`Item ${index + 1}: sources deve conter ao menos uma fonte.`);

    const ids = new Set();
    const sources = entry.sources.map((source, sourceIndex) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${project}: fonte ${sourceIndex + 1} inválida.`);
      const id = normalizeProjectKey(source.id || source.domain || source.tool || `fonte-${sourceIndex + 1}`);
      if (!id) throw new Error(`${project}: fonte ${sourceIndex + 1} sem id.`);
      if (ids.has(id)) throw new Error(`${project}: id de fonte duplicado: ${id}.`);
      ids.add(id);
      const tool = String(source.tool || '').trim();
      if (!tool) throw new Error(`${project}/${id}: informe tool.`);
      return {
        ...source,
        id,
        domain: String(source.domain || id).trim(),
        source: String(source.source || '').trim(),
        tool,
        topics: Array.isArray(source.topics) ? source.topics.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 80) : [],
        paths: Array.isArray(source.paths) ? source.paths.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 50) : [],
        fields: Array.isArray(source.fields) ? source.fields.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 80) : [],
        args: source.args && typeof source.args === 'object' && !Array.isArray(source.args) ? source.args : {},
        readOnly: source.readOnly !== false,
        priority: Math.max(0, Math.min(1000, Number(source.priority || 0)))
      };
    });

    return {
      project,
      name: String(entry.name || entry.project || project).trim(),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 30) : [],
      sources,
      schemaVersion: 1
    };
  }

  function parseLoad(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) { throw new Error(`JSON inválido: ${error.message}`); }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.length) throw new Error('A carga está vazia.');
    if (list.length > 50) throw new Error('Máximo de 50 projetos por carga.');
    return list.map(validateEntry);
  }

  async function firebaseApi() {
    const [appMod, fsMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js')
    ]);
    let app;
    const apps = appMod.getApps();
    if (apps.length) app = apps[0];
    else app = appMod.initializeApp(window.NEXUS_FIREBASE_CONFIG);
    return { app, db: fsMod.getFirestore(app), fs: fsMod };
  }

  function createUi() {
    const aside = document.querySelector('aside');
    if (aside && !document.getElementById('sourceMapSection')) {
      const section = document.createElement('div');
      section.id = 'sourceMapSection';
      section.className = 'sec';
      section.innerHTML = `
        <h2>Índice de Fontes</h2>
        <div class="card">
          <div class="t">Mapa operacional por projeto</div>
          <div class="s" id="sourceMapStatus">Carregue caminhos, ferramentas e assuntos em lote.</div>
          <div class="row"><button class="btn" id="openSourceMapBtn" type="button">Carga em lote</button></div>
        </div>`;
      const iaSection = [...aside.querySelectorAll('.sec')].find((node) => node.querySelector('h2')?.textContent?.trim() === 'IA');
      if (iaSection) aside.insertBefore(section, iaSection); else aside.appendChild(section);
    }

    if (!document.getElementById('sourceMapModal')) {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.id = 'sourceMapModal';
      modal.innerHTML = `
        <div class="box" style="width:min(920px,96vw)">
          <h3>Índice de Fontes do Nexus — carga em lote</h3>
          <div class="s">Cole um JSON com um projeto ou uma lista de projetos. A carga é validada antes de gravar. Cada projeto fica em <code>source_maps/{project}</code>, evitando índice composto e leituras desnecessárias.</div>
          <div class="row" style="margin:14px 0 8px">
            <button class="btn" id="sourceMapTemplateBtn" type="button">Carregar modelo ListaLar</button>
            <button class="btn" id="sourceMapValidateBtn" type="button">Validar carga</button>
          </div>
          <textarea id="sourceMapJson" class="full" style="min-height:360px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px" placeholder='[{"project":"listalar","sources":[...]}]'></textarea>
          <div id="sourceMapPreview" class="card" style="margin-top:10px;display:none"></div>
          <div class="row">
            <button class="btn primary" id="sourceMapSaveBtn" type="button" disabled>Salvar carga</button>
            <button class="btn" id="sourceMapCloseBtn" type="button">Cancelar</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }

    const openBtn = document.getElementById('openSourceMapBtn');
    const modal = document.getElementById('sourceMapModal');
    const text = document.getElementById('sourceMapJson');
    const preview = document.getElementById('sourceMapPreview');
    const saveBtn = document.getElementById('sourceMapSaveBtn');
    let validated = null;

    const resetValidation = () => {
      validated = null;
      saveBtn.disabled = true;
      preview.style.display = 'none';
      preview.innerHTML = '';
    };

    openBtn?.addEventListener('click', () => { modal.style.display = 'grid'; });
    document.getElementById('sourceMapCloseBtn')?.addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('sourceMapTemplateBtn')?.addEventListener('click', () => {
      text.value = JSON.stringify(TEMPLATE, null, 2);
      resetValidation();
    });
    text?.addEventListener('input', resetValidation);

    document.getElementById('sourceMapValidateBtn')?.addEventListener('click', () => {
      try {
        validated = parseLoad(text.value);
        const totalSources = validated.reduce((sum, item) => sum + item.sources.length, 0);
        preview.style.display = 'block';
        preview.innerHTML = `<div class="t">Carga válida</div><div class="s">${validated.length} projeto(s) • ${totalSources} fonte(s)</div>${validated.map((item) => `<div class="s"><strong>${esc(item.project)}</strong>: ${item.sources.map((source) => esc(`${source.domain} → ${source.tool}`)).join(' · ')}</div>`).join('')}`;
        saveBtn.disabled = false;
      } catch (error) {
        validated = null;
        saveBtn.disabled = true;
        preview.style.display = 'block';
        preview.innerHTML = `<div class="t" style="color:var(--err)">Carga inválida</div><div class="s">${esc(error.message)}</div>`;
      }
    });

    saveBtn?.addEventListener('click', async () => {
      if (!validated?.length) return;
      saveBtn.disabled = true;
      const original = saveBtn.textContent;
      saveBtn.textContent = 'Salvando...';
      try {
        const { db, fs } = await firebaseApi();
        for (const item of validated) {
          await fs.setDoc(fs.doc(db, 'source_maps', item.project), {
            ...item,
            updatedAt: fs.serverTimestamp(),
            updatedBy: String(window.NEXUS_STATE?.currentUser?.email || document.getElementById('userEmail')?.textContent || '')
          });
        }
        const totalSources = validated.reduce((sum, item) => sum + item.sources.length, 0);
        const status = document.getElementById('sourceMapStatus');
        if (status) status.textContent = `${validated.length} projeto(s) e ${totalSources} fonte(s) gravados no Firestore.`;
        if (typeof window.nexusAddMsg === 'function') window.nexusAddMsg('assistant', `Índice de fontes atualizado: ${validated.length} projeto(s), ${totalSources} fonte(s).`);
        modal.style.display = 'none';
      } catch (error) {
        console.error('Nexus source map save error', error);
        preview.style.display = 'block';
        preview.innerHTML = `<div class="t" style="color:var(--err)">Falha ao salvar</div><div class="s">${esc(error?.message || error)}</div>`;
      } finally {
        saveBtn.textContent = original;
        saveBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createUi, { once: true });
  else createUi();
})();
