let currentCollection = null;

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function refreshStatus() {
  try {
    const data = await api('/health');
    el('statusDot').className = 'dot ok';
    el('statusText').textContent = `online — ${data.collections.length} collection(s)`;
  } catch (e) {
    el('statusDot').className = 'dot err';
    el('statusText').textContent = 'offline';
  }
}

async function loadCollections() {
  const { collections } = await api('/collections');
  const list = el('collectionList');
  list.innerHTML = '';
  if (collections.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted-list';
    li.textContent = '(none yet — insert a document)';
    list.appendChild(li);
  }
  collections.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    if (name === currentCollection) li.classList.add('active');
    li.onclick = () => selectCollection(name);
    list.appendChild(li);
  });
  if (!currentCollection && collections.length > 0) {
    selectCollection(collections[0]);
  }
}

async function selectCollection(name) {
  currentCollection = name;
  await loadCollections();
  await loadIndexes();
  await runFind();
}

async function loadIndexes() {
  const list = el('indexList');
  list.innerHTML = '';
  if (!currentCollection) return;
  const { indexes } = await api(`/${currentCollection}/indexes`);
  if (indexes.length === 0) {
    const li = document.createElement('li');
    li.textContent = '(none)';
    list.appendChild(li);
    return;
  }
  indexes.forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    list.appendChild(li);
  });
}

function renderTable(docs) {
  const head = el('docTableHead');
  const body = el('docTableBody');
  head.innerHTML = '';
  body.innerHTML = '';

  if (docs.length === 0) {
    head.innerHTML = '<th>result</th>';
    body.innerHTML = '<tr class="empty-row"><td>no documents match</td></tr>';
    return;
  }

  const fields = [];
  docs.forEach((d) => Object.keys(d).forEach((k) => { if (!fields.includes(k)) fields.push(k); }));
  // put _id first
  fields.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));

  head.innerHTML = fields.map((f) => `<th>${f}</th>`).join('');
  body.innerHTML = docs
    .map((d) => {
      return (
        '<tr>' +
        fields
          .map((f) => {
            const v = d[f];
            const cls = f === '_id' ? ' class="id-cell"' : '';
            const text = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            return `<td${cls}>${escapeHtml(text)}</td>`;
          })
          .join('') +
        '</tr>'
      );
    })
    .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function runFind() {
  if (!currentCollection) return;
  let filter;
  try {
    filter = JSON.parse(el('filterInput').value || '{}');
  } catch (e) {
    el('resultMeta').textContent = 'invalid JSON filter';
    return;
  }
  const { documents } = await api(`/${currentCollection}/find`, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
  renderTable(documents);
  el('resultMeta').textContent = `${documents.length} document(s)`;
}

async function runCount() {
  if (!currentCollection) return;
  let filter;
  try {
    filter = JSON.parse(el('filterInput').value || '{}');
  } catch (e) {
    el('resultMeta').textContent = 'invalid JSON filter';
    return;
  }
  const { count } = await api(`/${currentCollection}/count`, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
  el('resultMeta').textContent = `count: ${count}`;
}

async function insertDoc() {
  let doc;
  try {
    doc = JSON.parse(el('insertInput').value);
  } catch (e) {
    el('insertMeta').textContent = 'invalid JSON';
    return;
  }
  let target = currentCollection;
  if (!target) {
    target = prompt('Collection name for this document:', 'docs');
    if (!target) return;
  }
  await api(`/${target}/insert`, { method: 'POST', body: JSON.stringify(doc) });
  el('insertMeta').textContent = 'inserted ✓';
  currentCollection = target;
  await loadCollections();
  await runFind();
}

el('findBtn').onclick = runFind;
el('countBtn').onclick = runCount;
el('insertBtn').onclick = insertDoc;
el('newCollBtn').onclick = () => {
  const name = prompt('New collection name:');
  if (name) selectCollection(name);
};
el('addIndexBtn').onclick = async () => {
  const field = el('indexField').value.trim();
  if (!field || !currentCollection) return;
  await api(`/${currentCollection}/index`, { method: 'POST', body: JSON.stringify({ field }) });
  el('indexField').value = '';
  await loadIndexes();
};

refreshStatus();
loadCollections();
setInterval(refreshStatus, 8000);
