#!/usr/bin/env python3
"""Verify and launch exact release archives; never install, rebuild or publish."""
import argparse,hashlib,json,os,queue,re,shutil,signal,subprocess,tarfile,threading,time
from pathlib import Path,PurePosixPath

MAX_OUTPUT=1024*1024
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def safe_extract(archive,root):
 root.mkdir(parents=True);seen=set();size=0
 with tarfile.open(archive,'r:gz') as tar:
  for m in tar:
   parts=PurePosixPath(m.name).parts
   if not parts or parts[0]!='package' or '..' in parts or '\\' in m.name or m.name in seen:
    raise ValueError('unsafe or duplicate archive member: '+m.name)
   seen.add(m.name);size+=m.size
   if len(seen)>4096 or size>256*1024*1024 or m.mode&0o7000:
    raise ValueError('archive limits or unsafe mode')
   target=root.joinpath(*parts[1:])
   if m.isdir():target.mkdir(parents=True,exist_ok=True)
   elif m.isfile():
    target.parent.mkdir(parents=True,exist_ok=True)
    with tar.extractfile(m) as source,target.open('xb') as dest:shutil.copyfileobj(source,dest)
    target.chmod(m.mode&0o777)
   else:raise ValueError('archive member is not regular file/directory: '+m.name)
def entry(root,relative,label):
 if not isinstance(relative,str) or not relative or '\\' in relative:
  raise ValueError(label+': invalid entry path')
 p=(root/relative).resolve()
 if root not in p.parents or not p.is_file():raise ValueError(label+': missing/outside entry '+relative)
 return p

class Child:
 def __init__(self,cmd,label,env,cwd,out,timeout,receipt):
  self.label=label;self.deadline=time.monotonic()+timeout;self.lines=queue.Queue();self.errors=[]
  self.p=subprocess.Popen(cmd,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  self.row={'name':label,'argv':cmd,'pid':self.p.pid,'processGroup':self.p.pid,'status':'RUNNING'};receipt['steps'].append(self.row)
  self.logs=[];self.threads=[]
  for stream,name in [(self.p.stdout,'stdout'),(self.p.stderr,'stderr')]:
   log=(out/(label+'-'+name+'.log')).open('wb');self.logs.append(log)
   def read(stream=stream,name=name,log=log):
    count=0
    try:
     while True:
      line=stream.readline(MAX_OUTPUT+1)
      if not line:
       if name=='stdout':self.lines.put(None)
       break
      count+=len(line)
      if count>MAX_OUTPUT:
       self.errors.append('output limit');self.p.terminate();break
      log.write(line);log.flush()
      if name=='stdout':self.lines.put(line)
    except Exception as e:self.errors.append(str(e))
   t=threading.Thread(target=read,daemon=True);t.start();self.threads.append(t)
 def send(self,value):
  self.p.stdin.write((json.dumps(value)+'\n').encode());self.p.stdin.flush()
 def line(self):
  if self.errors:raise RuntimeError(self.label+': '+self.errors[0])
  remaining=self.deadline-time.monotonic()
  if remaining<=0:raise TimeoutError(self.label+': timeout')
  try:line=self.lines.get(timeout=remaining)
  except queue.Empty:raise TimeoutError(self.label+': timeout')
  if line is None:raise RuntimeError(self.label+': exited before response')
  return line
 def request(self,number,method,params):
  self.send({'jsonrpc':'2.0','id':number,'method':method,'params':params})
  while True:
   v=json.loads(self.line())
   if not isinstance(v,dict) or v.get('jsonrpc')!='2.0':raise ValueError(self.label+': invalid JSON-RPC')
   if 'method' in v and 'id' in v:
    self.send({'jsonrpc':'2.0','id':v['id'],'error':{'code':-32601,'message':'No external action accepted by package smoke'}})
   if v.get('id')==number:
    if 'error' in v or 'result' not in v:raise RuntimeError(self.label+': RPC '+str(v))
    return v['result']
 def finish(self):
  self.p.stdin.close()
  self.p.wait(timeout=max(.1,self.deadline-time.monotonic()))
  if self.p.returncode!=0:raise RuntimeError(self.label+': exit '+str(self.p.returncode))
 def cleanup(self,success):
  # Only the process group created by this driver; never a host service.
  def group_alive():
   try:os.killpg(self.p.pid,0);return True
   except ProcessLookupError:return False
   except PermissionError:return True  # Unknown is not clean; Darwin can report EPERM for a zombie.
  def group_signal(value):
   try:os.killpg(self.p.pid,value)
   except ProcessLookupError:pass
   except PermissionError:
    # A zombie may reject a signal. Only a later ESRCH proves this group clean.
    self.row.setdefault('processGroupSignalErrors',[]).append('permission denied for signal '+str(value))
  cleanup_error=None
  try:
   # The leader can exit before descendants. Always clean this owned session.
   self.p.poll()
   group_signal(signal.SIGTERM)
   try:self.p.wait(timeout=2)
   except subprocess.TimeoutExpired:
    group_signal(signal.SIGKILL);self.p.wait(timeout=5)
   deadline=time.monotonic()+2
   while group_alive() and time.monotonic()<deadline:
    time.sleep(.02)
   if group_alive():group_signal(signal.SIGKILL)
   self.p.wait(timeout=5)
   deadline=time.monotonic()+2
   while group_alive() and time.monotonic()<deadline:time.sleep(.02)
   if group_alive():raise RuntimeError('owned process group remains after KILL')
  except Exception as e:
   cleanup_error=str(e);success=False
   # A denied group operation must fail, but still reap the directly owned leader.
   if self.p.poll() is None:
    self.p.kill();self.p.wait(timeout=5)
  for t in self.threads:t.join(timeout=2)
  if any(t.is_alive() for t in self.threads):self.errors.append('output reader still alive')
  else:
   for log in self.logs:log.close()
   for stream in [self.p.stdin,self.p.stdout,self.p.stderr]:
    if not stream.closed:stream.close()
  self.row.update(status='PASS' if success and not self.errors else 'FAIL',exit=self.p.returncode,reaped=self.p.returncode is not None,processGroupClean=cleanup_error is None)
  if cleanup_error:raise RuntimeError(self.label+': process group cleanup: '+cleanup_error)
  if self.errors and success:raise RuntimeError(self.label+': '+self.errors[0])

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['main-tgz','shell-tgz','metadata','checksums','node','output']:p.add_argument('--'+name,required=True)
 p.add_argument('--sdk-root',help='Optional pinned SDK harness directory; no SDK installation is performed')
 p.add_argument('--timeout-seconds',type=float,default=30)
 a=p.parse_args();out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=False)
 receipt={'schema':'popclaw-release-package-smoke/v1','status':'FAIL','steps':[],'nativeSdkRegistration':{'status':'not_run','reason':'sdk-root not supplied; optional independent check'},'scope':'Required exact local archive startup checks; no registry install, Gateway/model/House/social acceptance.'}
 inputs={};work=out/'work';stage='validate';ok=False
 try:
  if os.name!='posix':raise ValueError('This driver supports POSIX smoke runners only')
  if not 0<a.timeout_seconds<=120:raise ValueError('timeout-seconds must be >0 and <=120')
  main_tgz=Path(a.main_tgz).resolve();shell_tgz=Path(a.shell_tgz).resolve()
  inputs={str(x):digest(x) for x in [main_tgz,shell_tgz]};receipt['inputSha256']=inputs
  metadata=json.loads(Path(a.metadata).read_text());receipt['release']=metadata
  version=metadata['version'];commit=metadata['commit']
  if not re.fullmatch('[0-9a-f]{40}',commit) or metadata['tag']!='v'+version:raise ValueError('invalid release metadata')
  if metadata['main']!=main_tgz.name or metadata['shell']!=shell_tgz.name or main_tgz.name==shell_tgz.name:raise ValueError('metadata does not identify these two archives')
  sums={}
  for line in Path(a.checksums).read_text().splitlines():
   match=re.fullmatch(r'([0-9a-f]{64}) [ *](?:\./)?([^/\\]+)',line)
   if not match or match[2] in sums:raise ValueError('invalid/duplicate checksum entry')
   sums[match[2]]=match[1]
  if sums!={x.name:inputs[str(x)] for x in [main_tgz,shell_tgz]}:raise ValueError('archive checksum mismatch')
  node=Path(a.node).resolve()
  fixture=work/'fixture';module=fixture/'node_modules';implementation=module/'popclaw';shell=module/'popclaw-mcp'
  safe_extract(main_tgz,implementation);safe_extract(shell_tgz,shell)
  pkg=json.loads((implementation/'package.json').read_text());alias=json.loads((shell/'package.json').read_text())
  if pkg['name']!='popclaw' or alias['name']!='popclaw-mcp' or pkg['version']!=version or alias['version']!=version or alias['dependencies']!={'popclaw':version}:raise ValueError('package version/dependency mismatch')
  cli=entry(implementation,pkg['bin']['popclaw'],'main-entry');shell_cli=entry(shell,alias['bin']['popclaw-mcp'],'shell-entry')
  entry(implementation,pkg['main'],'native-entry')
  tools=json.loads((implementation/'openclaw.plugin.json').read_text())['contracts']['tools']
  if len(tools)!=55 or len(set(tools))!=55:raise ValueError('expected exactly 55 distinct tools')
  receipt['expectedTools']=tools
  home=work/'home';home.mkdir();data=work/'vault';helper=Path(__file__).with_name('release-package-runtime.mjs').resolve()
  env={k:v for k,v in os.environ.items() if k in ['LANG','LC_ALL','TMPDIR']}
  env.update(PATH=str(node.parent)+os.pathsep+'/usr/bin:/bin',HOME=str(home),POPCLAW_DATA_ROOT=str(data),POPCLAW_RECEIVE_ON_START='0',POPCLAW_NOTIFICATION_CONSUMER='release-package-smoke')
  def run(label,command):
   child=Child([str(node),'--import',str(helper)]+[str(x) for x in command],label,env,fixture,out,a.timeout_seconds,receipt);success=False
   try:child.finish();success=True
   finally:child.cleanup(success)
  stage='cli-help';run(stage,[cli,'--help'])
  stage='packaged-sqlite';run(stage,[helper,'sqlite',implementation])
  runtime=json.loads((out/'packaged-sqlite-stdout.log').read_text())
  if runtime.get('status')!='PASS' or runtime.get('mode')!='sqlite':raise ValueError('invalid SQLite probe receipt')
  receipt['runtime']={k:runtime[k] for k in ['node','abi','platform','arch']}
  if a.sdk_root:
   stage='native-sdk-register';sdk=Path(a.sdk_root).resolve();sdk_pkg=json.loads((sdk/'package.json').read_text())
   expected_sdk=pkg['openclaw']['build']['openclawVersion']
   if sdk_pkg['name']!='openclaw' or sdk_pkg['version']!=expected_sdk:raise ValueError('SDK harness version mismatch')
   receipt['sdkHarness']={'root':str(sdk),'version':expected_sdk,'manifestSha256':digest(sdk/'package.json')}
   run(stage,[helper,'native',implementation,sdk,work/'native-state'])
   receipt['nativeSdkRegistration']={'status':'PASS','sdkVersion':expected_sdk,'scope':'Optional actual package registration with SDK imports; not Gateway admission'}
  keys=[];stamps=[]
  for label,command in [('main-mcp',[cli,'mcp']),('shell-mcp',[shell_cli]),('main-mcp-restart',[cli,'mcp'])]:
   stage=label;child=Child([str(node),'--import',str(helper)]+[str(x) for x in command],label,env,fixture,out,a.timeout_seconds,receipt);success=False
   try:
    init=child.request(1,'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'popclaw-release-package-smoke','version':'1'}})
    info=init['serverInfo'];stamp=info['version']
    match=re.fullmatch(re.escape(version)+r' \d{4}-\d{2}-\d{2} \d{2}:\d{2}\+08 ([0-9a-f]{7,40}) \([^)]+\)',stamp)
    if info['name']!='popclaw' or not match or not commit.startswith(match[1]):raise ValueError(label+': wrong release build stamp')
    child.send({'jsonrpc':'2.0','method':'notifications/initialized'})
    listed=child.request(2,'tools/list',{})['tools'];names=[x['name'] for x in listed]
    if len(names)!=55 or set(names)!=set(tools):raise ValueError(label+': tool manifest mismatch')
    status=child.request(3,'tools/call',{'name':'popclaw_check_status','arguments':{}})
    if status.get('isError'):raise ValueError(label+': status failure')
    key=data/'vault/social/identity/master.key';keys.append(digest(key));stamps.append(stamp)
    child.row.update(toolCount=len(names),toolDigest=hashlib.sha256(json.dumps(sorted(names)).encode()).hexdigest(),buildStamp=stamp,identitySha256=keys[-1])
    child.finish();success=True
   finally:child.cleanup(success)
  if len(set(keys))!=1 or len(set(stamps))!=1:raise ValueError('identity/build changed across entrypoints/restart')
  receipt['requiredCheckCount']=5;receipt['status']='PASS';ok=True
 except Exception as e:receipt['error']=stage+': '+str(e)
 finally:
  after={}
  for name,value in inputs.items():
   try:after[name]=digest(Path(name))
   except OSError:after[name]=None
  receipt['inputSha256After']=after;receipt['inputsUnchanged']=after==inputs
  if after!=inputs:receipt.update(status='FAIL',error='archive inputs changed');ok=False
  shutil.rmtree(work,ignore_errors=True);receipt['fixtureRemoved']=not work.exists()
  if work.exists():receipt.update(status='FAIL',error='fixture cleanup failed');ok=False
  (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
  print(json.dumps({'status':receipt['status'],'receipt':str(out/'receipt.json'),'error':receipt.get('error')}))
 return 0 if ok else 1
if __name__=='__main__':raise SystemExit(main())
