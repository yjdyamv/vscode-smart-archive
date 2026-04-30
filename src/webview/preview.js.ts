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

function getPath(el){return el.closest('.rw').dataset.path}

function parentRow(el){
  var g=el.parentElement;
  while(g&&g!==document.body){
    if(g.classList.contains('grp')){
      var p=g.previousElementSibling;
      if(p&&p.classList.contains('rw')&&p.classList.contains('dir'))return p
    }
    g=g.parentElement
  }
  return null
}

function getAllDescendants(el){
  var result=[],grp=el.nextElementSibling;
  if(!grp||!grp.classList.contains('grp'))return result;
  var kids=grp.querySelectorAll('.rw');
  for(var i=0;i<kids.length;i++) result.push(kids[i]);
  return result
}

function dedupPaths(s){
  var arr=[...s],result=[];
  for(var i=0;i<arr.length;i++){
    var p=arr[i],parts=p.replace(/\\\\/g,'/').split('/'),covered=false;
    for(var j=parts.length-2;j>=0;j--){
      if(s.has(parts.slice(0,j+1).join('/'))){covered=true;break}
    }
    if(!covered)result.push(p)
  }
  return result
}

function visibleCount(){
  return dedupPaths(sel).length
}

function updateUI(){
  var all=document.querySelectorAll('.rw');
  for(var i=0;i<all.length;i++){
    var el=all[i],p=getPath(el),ck=el.querySelector('.ck');
    var on=sel.has(p);
    ck.classList.toggle('on',on);
    ck.classList.toggle('part',false);
    el.classList.toggle('sel',on)
  }
  var dirs=document.querySelectorAll('.rw.dir');
  for(var i=0;i<dirs.length;i++){
    var d=dirs[i],dp=getPath(d);
    if(sel.has(dp))continue;
    var kids=getAllDescendants(d);
    if(!kids.length)continue;
    var any=false,all2=true;
    for(var j=0;j<kids.length;j++){
      if(sel.has(getPath(kids[j])))any=true;else all2=false
    }
    if(any&&all2){
      d.querySelector('.ck').classList.add('on');
      d.classList.add('sel')
    }else if(any){
      d.querySelector('.ck').classList.add('part')
    }
  }
  var cnt=visibleCount();
  document.getElementById('cnt').textContent=cnt;
  document.getElementById('bSel').disabled=cnt===0
}

function toggleRow(el){
  var p=getPath(el);
  if(sel.has(p)){
    sel.delete(p);
    unselDescendants(el)
  }else{
    sel.add(p);
    var prw=parentRow(el);
    if(prw){
      var pp=getPath(prw);
      if(sel.has(pp)){
        sel.delete(pp);
        var ds=getAllDescendants(prw);
        for(var i=0;i<ds.length;i++) sel.add(getPath(ds[i]))
      }
    }
    selDescendants(el)
  }
  updateUI()
}

function selDescendants(el){
  var kids=getAllDescendants(el);
  for(var i=0;i<kids.length;i++) sel.add(getPath(kids[i]))
}

function unselDescendants(el){
  var kids=getAllDescendants(el);
  for(var i=0;i<kids.length;i++) sel.delete(getPath(kids[i]))
}

function selOne(e){
  e.stopPropagation();
  toggleRow(e.currentTarget.closest('.rw'))
}

function selRow(e,el){
  if(e.target.closest('.cb'))return;
  if(e.ctrlKey||e.metaKey){
    toggleRow(el)
  }else{
    sel.clear();
    var all=document.querySelectorAll('.rw');
    for(var i=0;i<all.length;i++){
      all[i].classList.remove('sel');
      all[i].querySelector('.ck').classList.remove('on','part')
    }
    toggleRow(el)
  }
  updateUI()
}

function extAll(){
  document.getElementById('s').className='st';
  document.getElementById('s').textContent='Extracting all files\\u2026';
  v.postMessage({c:'extAll'})
}

function extSel(){
  var ps=dedupPaths(sel);if(!ps.length)return;
  var flat=true;
  var dirs=document.querySelectorAll('.rw.dir');
  for(var i=0;i<dirs.length;i++){if(sel.has(getPath(dirs[i]))){flat=false;break}}
  document.getElementById('s').className='st';
  document.getElementById('s').textContent='Extracting '+ps.length+' item(s)\\u2026';
  v.postMessage({c:'extSel',paths:ps,flat:flat})
}

function togDir(e,el){
  if(e.ctrlKey||e.metaKey){selRow(e,el);return}
  var nx=el.nextElementSibling;
  if(!nx||!nx.classList.contains('grp'))return;
  var ar=el.querySelector('.ar'),hd=nx.style.display!=='none';
  nx.style.display=hd?'none':'';
  if(ar)ar.textContent=hd?'\\u25B6':'\\u25BC'
}

window.addEventListener('message',function(e){
  var s=document.getElementById('s');
  if(e.data.c==='ok'){s.className='st ok';s.textContent=e.data.t}
  else if(e.data.c==='err'){s.className='st er';s.textContent=e.data.t}
  else if(e.data.c==='log'){v.postMessage({c:'log',msg:e.data.msg})}
});

document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='a'){
    e.preventDefault();
    var all=document.querySelectorAll('.rw:not(.dir)');
    for(var i=0;i<all.length;i++){sel.add(getPath(all[i]))}
    updateUI()
  }
});
`;
