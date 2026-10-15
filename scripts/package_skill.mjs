#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
if(argv.some((v,i)=>i!==0&&i!==1)|| (argv.length&&argv[0]!=='--output') || argv.length===1)throw new Error('Usage: node scripts/package_skill.mjs [--output DIRECTORY]');
const output=path.resolve(argv[1]||path.join(root,'skills/midi-tool'));
const template=path.join(root,'skills/midi-tool');
if(output===root||output===path.parse(output).root)throw new Error('Unsafe output directory');
const stat=await fs.lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;});if(stat?.isSymbolicLink())throw new Error('Output must not be a symbolic link');
await fs.mkdir(path.dirname(output),{recursive:true});
const stage=await fs.mkdtemp(path.join(path.dirname(output),'.midi-tool-package-'));
const dependencies=new Set(['midi','midi-file','zod']);
const visited=new Set();
async function collect(relative){
 relative=path.normalize(relative);if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.endsWith('.js'))throw new Error(`Unsafe compiled import: ${relative}`);
 if(visited.has(relative))return;visited.add(relative);
 const text=await fs.readFile(path.join(root,'dist',relative),'utf8');
 if(text.includes('@modelcontextprotocol/')||/\bglobalThis\.__/.test(text))throw new Error(`Legacy runtime dependency: ${relative}`);
 const imports=[];
 const source=ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 function visit(node){
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
  if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument))throw new Error(`Nonliteral dynamic import in ${relative}`);imports.push(argument.text);}
  ts.forEachChild(node,visit);
 }
 visit(source);
 for(const specifier of imports){if(specifier.startsWith('.'))await collect(path.join(path.dirname(relative),specifier));else if(!specifier.startsWith('node:')&&!dependencies.has(specifier))throw new Error(`Unexpected package dependency ${specifier} in ${relative}`);}
 const destination=path.join(stage,'lib',relative);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,text);
}
try{
 await collect('cli/main.js');await collect('local/runtime.js');
 for(const name of ['SKILL.md','package.json','package-lock.json','.gitignore','scripts','references'])await fs.cp(path.join(template,name),path.join(stage,name),{recursive:true});
 const pkg=JSON.parse(await fs.readFile(path.join(stage,'package.json'),'utf8'));
 if(Object.keys(pkg.dependencies).some(name=>!dependencies.has(name)))throw new Error('Unexpected distributable dependency');
 // Existing generated code is only replaced when it contains JS files/directories;
 // unexpected user files (including recordings) stop packaging rather than being removed.
 async function checkGenerated(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isDirectory())await checkGenerated(path.join(dir,entry.name));else if(!entry.isFile()||!entry.name.endsWith('.js'))throw new Error(`Refusing to replace unexpected file: ${path.join(dir,entry.name)}`);}}
 const lib=path.join(output,'lib');try{await checkGenerated(lib);}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.mkdir(output,{recursive:true});
 const backup=path.join(stage,'old-lib');let hadLib=false;
 try{await fs.rename(lib,backup);hadLib=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await fs.rename(path.join(stage,'lib'),lib);}catch(error){if(hadLib)await fs.rename(backup,lib);throw error;}
 for(const name of ['SKILL.md','package.json','package-lock.json','.gitignore','scripts','references'])await fs.cp(path.join(stage,name),path.join(output,name),{recursive:true});
 process.stdout.write(JSON.stringify({ok:true,output,modules:[...visited].sort()})+'\n');
}finally{await fs.rm(stage,{recursive:true,force:true});}
