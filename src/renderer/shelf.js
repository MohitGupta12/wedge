// Floating shelf: park files, then drag them out into other apps.
const list = document.getElementById('items');
const shelfEl = document.getElementById('shelf');
const dragAll = document.getElementById('drag-all');
let items = [];

async function render() {
  list.textContent = '';
  document.getElementById('empty').hidden = items.length > 0;
  dragAll.hidden = items.length < 2;
  for (const p of items) {
    const li = document.createElement('li');
    li.draggable = true;
    li.title = p;
    const img = document.createElement('img');
    img.alt = '';
    wedge.fileIcon(p).then((url) => { if (url) img.src = url; });
    const name = document.createElement('span');
    name.textContent = p.split(/[\\/]/).pop();
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Remove from shelf';
    remove.onclick = async () => { items = await wedge.shelf.remove(p); render(); };
    li.append(img, name, remove);
    li.addEventListener('dragstart', (e) => {
      e.preventDefault();
      wedge.shelf.startDrag([p]);
    });
    li.addEventListener('dblclick', () => wedge.openPath(p));
    list.append(li);
  }
}

dragAll.draggable = true;
dragAll.addEventListener('dragstart', (e) => {
  e.preventDefault();
  wedge.shelf.startDrag(items);
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  shelfEl.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) shelfEl.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  shelfEl.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => wedge.pathFor(f)).filter(Boolean);
  if (paths.length) wedge.shelf.add(paths);
});

document.getElementById('clear').onclick = () => { items = []; render(); wedge.shelf.clear(); };
document.getElementById('close').onclick = () => window.close();

wedge.on.shelfItems((paths) => { items = paths; render(); });
wedge.shelf.list().then((paths) => { items = paths; render(); });
