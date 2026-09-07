/** Tiny, dependency-free build for this project's named ES-module imports.
 * This is not a general-purpose JavaScript parser. It deliberately rejects
 * unsupported import/export syntax instead of silently producing bad output.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const importPattern=/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
async function bundle(entry,replacements={}){
  const modules=new Map(),visit=async file=>{
    file=path.posix.normalize(file);if(modules.has(file))return;
    let source=await fs.readFile(path.join(root,file),'utf8'),dependencies=[];
    for(const match of source.matchAll(importPattern)){const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[2]));dependencies.push(dependency);}
    for(const dependency of dependencies)await visit(dependency);
    source=source.replace(importPattern,(_,names,relative)=>{const id=path.posix.normalize(path.posix.join(path.posix.dirname(file),relative));return `const {${names}}=__modules[${JSON.stringify(id)}];`;});
    const exports=[];source=source.replace(/^export\s+(async\s+function|class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,(_,kind,name)=>{exports.push(name);return `${kind} ${name}`;});
    if(/^\s*(?:import|export)\s/m.test(source))throw new Error(`Unsupported module syntax in ${file}`);
    for(const [pattern,replacement]of Object.entries(replacements))source=source.replaceAll(pattern,replacement);
    modules.set(file,`__modules[${JSON.stringify(file)}]=(()=>{\n${source}\nreturn {${exports.join(',')}};\n})();`);
  };
  await visit(entry);return `(()=>{\n'use strict';\nconst __modules=Object.create(null);\n${[...modules.values()].join('\n')}\n})();`;
}
const worker=await bundle('src/worker.js'),worklet=await fs.readFile(path.join(root,'src/recorder-worklet.js'),'utf8');
const replacements={
  "new Worker(new URL('./worker.js',import.meta.url),{type:'module'})":`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})),{type:'classic'})`,
  "new URL('./recorder-worklet.js',import.meta.url)":`URL.createObjectURL(new Blob([${JSON.stringify(worklet)}],{type:'text/javascript'}))`
};
const app=await bundle('src/app.js',replacements),css=await fs.readFile(path.join(root,'styles.css'),'utf8'),icon=await fs.readFile(path.join(root,'assets/icon.svg'),'utf8');
let html=await fs.readFile(path.join(root,'index.html'),'utf8');
html=html.replace('<link rel="stylesheet" href="styles.css">',`<style>\n${css}\n</style>`)
  .replace('href="assets/icon.svg"',`href="data:image/svg+xml,${encodeURIComponent(icon)}"`)
  .replace('<script type="module" src="src/app.js"></script>',`<script type="module">\n${app.replace(/<\/script/gi,'<\\/script')}\n</script>`);
await fs.mkdir(path.join(root,'dist'),{recursive:true});await fs.writeFile(path.join(root,'dist/sonora-studio.html'),html);
console.log(`Built dist/sonora-studio.html (${(Buffer.byteLength(html)/1024).toFixed(1)} KiB). No dependencies or network resources.`);
