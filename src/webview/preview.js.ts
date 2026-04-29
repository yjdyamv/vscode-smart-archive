/**
 * Archive preview JavaScript — Smart Archive VSCode Extension
 *
 * Embedded in the archive viewer webview. Handles selection,
 * expand/collapse, and messaging with the extension host.
 *
 * @module webview/archive.js
 */

export const PREVIEW_JS = `
var v=acquireVsCodeApi();
var sel=new Set();
function updateUI(){var n=sel.size;document.getElementById('cnt').textContent=n;document.getElementById('bSel').disabled=n===0}
function getPath(el){return el.closest('.rw').dataset.path}
function toggleRow(el){
  var p=getPath(el),k=el.querySelector('.ck');
  if(sel.has(p)){sel.delete(p);k.classList.remove('on');el.classList.remove('sel');unselKids(el)}
  else{sel.add(p);k.classList.add('on');el.classList.add('sel');selKids(el)}
  updateUI()
}
function selOne(e){
  e.stopPropagation();
  toggleRow(e.currentTarget.closest('.rw'))
}
function selRow(e,el){
  if(e.target.closest('.cb'))return;
  if(e.ctrlKey||e.metaKey){
    toggleRow(el);
  } else {
    sel.clear();
    var all=document.querySelectorAll('.rw.sel');
    for(var i=0;i<all.length;i++){all[i].classList.remove('sel');all[i].querySelector('.ck').classList.remove('on')}
    toggleRow(el);
  }
  updateUI()
}
function selKids(el){
  var g=el.nextElementSibling;
  if(!g||!g.classList.contains('grp'))return;
  var rs=g.querySelectorAll('.rw');
  for(var i=0;i<rs.length;i++){
    var p=getPath(rs[i]);
    if(!sel.has(p)){sel.add(p);rs[i].querySelector('.ck').classList.add('on')}
  }
}
function unselKids(el){
  var g=el.nextElementSibling;
  if(!g||!g.classList.contains('grp'))return;
  var rs=g.querySelectorAll('.rw');
  for(var i=0;i<rs.length;i++){
    var p=getPath(rs[i]);
    sel.delete(p);rs[i].querySelector('.ck').classList.remove('on')
  }
}
function extAll(){
  document.getElementById('s').className='st';document.getElementById('s').textContent='Extracting all files\u2026';
  v.postMessage({c:'extAll'})
}
function extSel(){
  var ps=[...sel];if(!ps.length)return;
  document.getElementById('s').className='st';document.getElementById('s').textContent='Extracting '+ps.length+' file(s)\u2026';
  v.postMessage({c:'extSel',paths:ps})
}
function togDir(e,el){
  if(e.ctrlKey||e.metaKey){selRow(e,el);return}
  e.stopPropagation();
  var nx=el.nextElementSibling;
  if(!nx||!nx.classList.contains('grp'))return;
  var ar=el.querySelector('.ar'),hd=nx.style.display!=='none';
  nx.style.display=hd?'none':'';
  if(ar)ar.textContent=hd?'\u25B6':'\u25BC'
}
window.addEventListener('message',function(e){
  var s=document.getElementById('s');
  if(e.data.c==='ok'){s.className='st ok';s.textContent=e.data.t}
  else if(e.data.c==='err'){s.className='st er';s.textContent=e.data.t}
  else if(e.data.c==='log'){v.postMessage({c:'log',msg:e.data.msg})}
});
`;
