#!/usr/bin/env python3
import base64, copy, hashlib, importlib.util, io, json, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('verifier',ROOT/'scripts/verify-retained-clawhub.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
COMMIT='a'*40

class SourceGuards(unittest.TestCase):
 def setUp(self):
  self.run={'id':123,'run_attempt':1,'head_sha':COMMIT,'head_branch':'v0.1.3','event':'push','path':'.github/workflows/release.yml','status':'completed','conclusion':'failure','repository':{'full_name':'PopClaw-xyz/popclaw'},'head_repository':{'full_name':'PopClaw-xyz/popclaw'}}
  self.jobs=[{'name':'build, verify and publish','steps':[{'name':'Smoke the exact packages before publication','conclusion':'success'}]}]
 def check(self,run=None,jobs=None):
  return v.validate_run(run or self.run,self.jobs if jobs is None else jobs,'PopClaw-xyz/popclaw',123,'.github/workflows/release.yml',COMMIT,'v0.1.3')
 def test_valid_tested_failed_publish_run_is_accepted(self):self.check()
 def test_wrong_source_identity_is_refused(self):
  for patch in [{'id':124},{'head_sha':'b'*40},{'head_branch':'main'},{'event':'pull_request'},{'path':'.github/workflows/other.yml'},{'status':'in_progress'},{'repository':{'full_name':'outsider/repo'}},{'head_repository':{'full_name':'outsider/repo'}}]:
   with self.subTest(patch=patch),self.assertRaises(ValueError):self.check(dict(self.run,**patch))
 def test_untested_retained_source_is_refused(self):
  for conclusion in ['failure','skipped','cancelled',None]:
   jobs=copy.deepcopy(self.jobs);jobs[0]['steps'][0]['conclusion']=conclusion
   with self.subTest(conclusion=conclusion),self.assertRaises(ValueError):self.check(jobs=jobs)
 def test_only_one_unexpired_artifact_from_exact_run_is_accepted(self):
  good={'id':9,'name':'release-artefacts-v0.1.3','expired':False,'digest':'sha256:'+'b'*64,'workflow_run':{'id':123,'head_sha':COMMIT}}
  self.assertEqual(v.select_artifact([good],good['name'],self.run)['id'],9)
  for rows in [[],[good,good],[dict(good,expired=True)],[dict(good,name='different')],[dict(good,workflow_run={'id':124,'head_sha':COMMIT})],[dict(good,workflow_run={'id':123,'head_sha':'c'*40})]]:
   with self.subTest(rows=rows),self.assertRaises(ValueError):v.select_artifact(rows,good['name'],self.run)
 def test_input_validation(self):
  self.assertEqual(v.validate_inputs('v0.1.3',COMMIT,'c'*64,'123'),'0.1.3')
  for values in [('v0.1.3\n',COMMIT,'c'*64,'123'),('v0.1.3','a'*39,'c'*64,'123'),('v0.1.3',COMMIT,'c'*63,'123'),('v0.1.3',COMMIT,'c'*64,'1;bad')]:
   with self.subTest(values=values),self.assertRaises(ValueError):v.validate_inputs(*values)

 def test_native_resume_requires_both_verification_and_retention(self):
  run=dict(self.run,path=v.WORKFLOW,event='workflow_dispatch')
  jobs=[{'name':'prepare and retain','steps':[{'name':name,'conclusion':'success'} for name in ['Verify and smoke retained ClawHub bytes','Retain ClawHub release bytes']]}]
  v.validate_run(run,jobs,'PopClaw-xyz/popclaw',123,v.WORKFLOW)
  for index in range(2):
   broken=copy.deepcopy(jobs);broken[0]['steps'][index]['conclusion']='failure'
   with self.assertRaises(ValueError):v.validate_run(run,broken,'PopClaw-xyz/popclaw',123,v.WORKFLOW)

 def test_tag_resolution_binds_tag_run_head_and_fixed_source(self):
  artifact={'id':9,'name':'release-artefacts-v0.1.3','expired':False,'digest':'sha256:'+'b'*64,'workflow_run':{'id':123,'head_sha':COMMIT}}
  def response(path):
   if '/git/ref/tags/' in path:return {'object':{'type':'tag','sha':'d'*40}}
   if '/git/tags/' in path:return {'object':{'type':'commit','sha':COMMIT}}
   if '/jobs?' in path:return {'jobs':self.jobs}
   if '/artifacts?' in path:return {'artifacts':[artifact]}
   return self.run
  with tempfile.TemporaryDirectory() as folder,patch.dict(v.os.environ,{'GITHUB_REPOSITORY':'PopClaw-xyz/popclaw'}),patch.object(v,'api',side_effect=response):
   args=SimpleNamespace(tag='v0.1.3',commit=COMMIT,full_sha256='c'*64,source_run_id='123',resume_from_run_id='',output=folder+'/context.json',github_output=None)
   result=v.resolve_context(args)
   self.assertEqual(result['source']['artifactId'],9)
   args.commit='f'*40
   with self.assertRaisesRegex(ValueError,'tag moved'):v.resolve_context(args)

def json_bytes(value):return (json.dumps(value)+'\n').encode()
def pack(path,files,extras=()):
 with tarfile.open(path,'w:gz') as archive:
  for name,(data,mode) in files.items():
   member=tarfile.TarInfo('package/'+name);member.size=len(data);member.mode=mode
   archive.addfile(member,io.BytesIO(data))
  for member in extras:archive.addfile(member,io.BytesIO(b'x'*member.size))
def statistics(path,name,version):
 data=path.read_bytes()
 return {'name':name,'version':version,'filename':path.name,'bytes':len(data),'sha256':v.digest(data),
         'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}

class ArchiveGuards(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.version='0.1.3';self.full_path=self.root/'full.tgz';self.out=self.root/'derived';self.out.mkdir()
  main={'name':'popclaw','version':self.version,'license':'Apache-2.0','repository':{'url':'git+https://github.com/PopClaw-xyz/popclaw.git'},'engines':{'node':'>=24.16.0 <25 || >=26.1.0'},'openclaw':{'extensions':['./dist/bundled/index.js']}}
  native={'name':'better-sqlite3','version':'12.11.1','license':'MIT','dependencies':{'bindings':'^1.5.0'}}
  self.full={'package.json':(json_bytes(main),0o644),v.NATIVE+'/package.json':(json_bytes(native),0o644),
             v.NATIVE+'/POPCLAW-RUNTIME-MANIFEST.json':(json_bytes({'upstreamManifestSha256':'c'*64}),0o644)}
  for path in ['LICENSE','NOTICE',v.NATIVE+'/LICENSE',v.NATIVE+'/src/better_sqlite3.cpp',v.NATIVE+'/deps/sqlite3/sqlite3.c',v.NATIVE+'/binding.gyp','migrations/001.sql']:
   self.full[path]=(b'preserved '+path.encode(),0o644)
  self.full['dist/bundled/cli.js']=(b'#!/usr/bin/env node\n',0o755)
  rows=[]
  for index,((platform,arch),name) in enumerate(zip(v.PLATFORMS,v.NAMES)):
   row={'name':name,'version':self.version,'platform':platform,'arch':arch}
   if platform=='linux':row['libc']='glibc'
   row['bindings']=[]
   for major,abi in v.ABI.items():
    filename=f'better_sqlite3-{platform}-{arch}-node{major}.node';data=bytes([index+major])*500001
    self.full[v.RELEASE+filename]=(data,0o755)
    row['bindings'].append({'nodeMajor':major,'abi':abi,'file':filename,'sha256':v.digest(data),'size':len(data)})
   rows.append(row)
  pack(self.full_path,self.full)
  self.context={'format':1,'repository':'PopClaw-xyz/popclaw','tag':'v'+self.version,'version':self.version,'sourceCommit':COMMIT,'fullSha256':v.digest(self.full_path.read_bytes()),'source':{'runId':123}}
  source={'fullArchiveFilename':self.full_path.name,'fullArchiveSha256':self.context['fullSha256'],'fullArchiveBytes':self.full_path.stat().st_size,'package':{'name':'popclaw','version':self.version}}
  marker={'format':1,'distribution':'clawhub-platform-dependencies','version':self.version,'packages':rows}
  deps={name:self.version for name in v.NAMES}
  derived_main=copy.deepcopy(main);derived_main.update(name='popclaw-clawhub',optionalDependencies=deps);derived_main['openclaw']['install']={'requiredPlatformPackages':v.NAMES}
  self.archives={'popclaw-clawhub':{path:value for path,value in self.full.items() if not path.endswith('.node')}}
  self.archives['popclaw-clawhub'].update({'package.json':(json_bytes(derived_main),0o644),v.NATIVE+'/package.json':(json_bytes(dict(native,optionalDependencies=deps)),0o644),v.MARKER:(json_bytes(marker),0o644)})
  licenses=['LICENSE','NOTICE',v.NATIVE+'/LICENSE'];source_files=[path for path in self.full if path.endswith(('.cpp','.c','.gyp'))]
  inv=lambda paths:[{'path':path,'size':len(self.full[path][0]),'sha256':v.digest(self.full[path][0])} for path in paths]
  for row in rows:
   name=row['name'];pkg={'name':name,'version':self.version,'license':'(Apache-2.0 AND MIT)','os':[row['platform']],'cpu':[row['arch']],'repository':main['repository'],'engines':main['engines']}
   if 'libc' in row:pkg['libc']=[row['libc']]
   provenance={'format':1,'source':source,'package':{key:value for key,value in row.items() if key!='bindings'},'bindings':row['bindings'],
               'upstream':{'name':native['name'],'version':native['version'],'manifestSha256':'c'*64,'runtimeProvenanceSha256':v.digest(self.full[v.NATIVE+'/POPCLAW-RUNTIME-MANIFEST.json'][0])},'licenses':inv(licenses),'sourceFiles':inv(source_files)}
   files={'package.json':(json_bytes(pkg),0o644),'README.md':(b'data-only',0o644),'POPCLAW-NATIVE-PROVENANCE.json':(json_bytes(provenance),0o644)}
   for path in licenses:files[path if path in ('LICENSE','NOTICE') else 'licenses/better-sqlite3/LICENSE']=self.full[path]
   for binding in row['bindings']:files['build/Release/'+binding['file']]=self.full[v.RELEASE+binding['file']]
   self.archives[name]=files
  self.receipt={'format':1,'profile':'clawhub','source':source,'artifactDirectory':f'popclaw-clawhub-{self.version}-{self.context["fullSha256"][:12]}','marker':marker}
  self.write_archives()

 def write_archives(self):
  self.receipt['packages']=[]
  for name,files in self.archives.items():
   path=self.out/f'{name}-{self.version}.tgz';pack(path,files);self.receipt['packages'].append(statistics(path,name,self.version))
  (self.out/'receipt.json').write_bytes(json_bytes(self.receipt))

 def verify(self):return v.verify_derived(self.out,self.full_path,self.context)

 def test_valid_six_archives_pass_and_preserve_executable_modes(self):
  actual,rows=self.verify();self.assertEqual(len(rows),6);self.assertEqual(actual['popclaw-clawhub']['dist/bundled/cli.js'][1],0o755)

 def test_self_resigning_receipt_cannot_hide_changed_main_source(self):
  self.archives['popclaw-clawhub']['migrations/001.sql']=(b'changed source',0o644);self.write_archives()
  with self.assertRaisesRegex(ValueError,'source bytes/mode'):self.verify()

 def test_self_resigning_receipt_cannot_hide_wrong_native_binary(self):
  path=next(path for path in self.archives[v.NAMES[0]] if path.endswith('.node'))
  self.archives[v.NAMES[0]][path]=(b'changed'+b'X'*500001,0o755);self.write_archives()
  with self.assertRaisesRegex(ValueError,'binding bytes/mode'):self.verify()

 def test_wrong_platform_scripts_license_and_source_provenance_are_refused(self):
  original=copy.deepcopy(self.archives[v.NAMES[0]])
  for change in ['platform','scripts','license','provenance','peerDependencies','publishConfig','license_metadata']:
   with self.subTest(change=change):
    self.archives[v.NAMES[0]]=copy.deepcopy(original);files=self.archives[v.NAMES[0]]
    if change in ('peerDependencies','publishConfig','license_metadata'):
     pkg=json.loads(files['package.json'][0]);pkg['license' if change=='license_metadata' else change]='wrong license' if change=='license_metadata' else {'unapproved':'https://example.test'};files['package.json']=(json_bytes(pkg),0o644)
    elif change in ('platform','scripts'):
     pkg=json.loads(files['package.json'][0]);pkg['cpu' if change=='platform' else 'scripts']=['x64'] if change=='platform' else {'install':'bad'};files['package.json']=(json_bytes(pkg),0o644)
    elif change=='license':files['LICENSE']=(b'wrong license',0o644)
    else:
     provenance=json.loads(files['POPCLAW-NATIVE-PROVENANCE.json'][0]);provenance['sourceFiles'][0]['sha256']='0'*64;files['POPCLAW-NATIVE-PROVENANCE.json']=(json_bytes(provenance),0o644)
    self.write_archives()
    with self.assertRaises(ValueError):self.verify()

 def test_wrong_source_receipt_context_or_extra_archive_is_refused(self):
  (self.out/'release-context.json').write_bytes(json_bytes(dict(self.context,sourceCommit='b'*40)))
  with self.assertRaisesRegex(ValueError,'context differs'):self.verify()
  (self.out/'release-context.json').unlink();(self.out/'extra.tgz').write_bytes(b'X')
  with self.assertRaisesRegex(ValueError,'unexpected retained archive'):self.verify()

 def test_resume_requires_retained_source_context(self):
  self.context['resume']={'runId':99}
  with self.assertRaisesRegex(ValueError,'retained context'):self.verify()

 def test_archive_reader_rejects_links_duplicates_traversal_and_file_parent(self):
  for kind in ['traversal','duplicate','symlink','hardlink','file_parent']:
   with self.subTest(kind=kind):
    path=self.root/'unsafe.tgz';files={'package.json':(b'{}',0o644)}
    item=tarfile.TarInfo({'traversal':'package/../escape','duplicate':'package/package.json','file_parent':'package/parent/child'}.get(kind,'package/link'))
    if kind in ('symlink','hardlink'):item.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE;item.linkname='../../outside'
    if kind=='file_parent':files['parent']=(b'file',0o644)
    pack(path,files,[item])
    with self.assertRaises(ValueError):v.archive_files(path)

if __name__=='__main__':unittest.main()
