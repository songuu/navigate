// Run on the existing host only. Credentials stay in memory and server-owned
// environment files; subprocess arguments and stdout never contain passwords.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parse} from 'dotenv';

const shared='/opt/navigate/shared';
const old='/opt/agent-build/worker-runtimes/news-collector-active/.env';
const psql=sql=>execFileSync('docker',['exec','-i','agent-build-postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});
fs.mkdirSync(shared,{recursive:true,mode:0o750});
if(fs.existsSync(`${shared}/content-api.env`)||fs.existsSync(`${shared}/news-collector.env`)){
  if(!fs.existsSync(`${shared}/content-api.env`)||!fs.existsSync(`${shared}/news-collector.env`))throw new Error('Partial credential files exist; resolve them before provisioning.');
  if(!fs.existsSync(`${shared}/news-database-owned`))throw new Error('Credential files exist without database ownership proof; refusing to replace unknown data.');
  console.log('Existing server-only credentials retained.');process.exit(0);
}
const reader=crypto.randomBytes(32).toString('hex'),writer=crypto.randomBytes(32).toString('hex');
const roles=psql("SELECT rolname FROM pg_roles WHERE rolname IN ('navigate_readonly','navigate_writer');");
if(roles.trim())throw new Error('Navigate roles already exist without credential files; refusing to rotate unknown credentials.');
if(psql("SELECT datname FROM pg_database WHERE datname='navigate';").trim())throw new Error('An existing navigate database was not created by this migration; refusing to modify it.');
psql(`CREATE ROLE navigate_readonly LOGIN PASSWORD '${reader}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;\nCREATE ROLE navigate_writer LOGIN PASSWORD '${writer}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;\nSELECT 'CREATE DATABASE navigate' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='navigate')\n\\gexec\n`);
const common={CONTENT_REPOSITORY_DRIVER:'postgres',CONTENT_REPOSITORY_POSTGRES_ONLY:'true',CONTENT_POSTGRES_SSL:'false'};
const api={...common,CONTENT_POSTGRES_READ_URL:`postgresql://navigate_readonly:${reader}@127.0.0.1:5432/navigate`,CONTENT_API_ENABLED:'1',CONTENT_API_HOST:'127.0.0.1',CONTENT_API_PORT:'5190',CONTENT_API_ALLOWED_HOSTS:'songuu.top,127.0.0.1:5190,localhost:5190',CONTENT_API_ALLOWED_ORIGINS:'https://songuu.top',CONTENT_API_ALLOW_MISSING_ORIGIN:'true'};
const previous=parse(fs.readFileSync(old));
const collector=Object.fromEntries(Object.entries(previous).filter(([key])=>/^(NEWS_|LLM_|ANTHROPIC_|OPENAI_|OLLAMA_)/.test(key)));
Object.assign(collector,common,{CONTENT_POSTGRES_WRITE_URL:`postgresql://navigate_writer:${writer}@127.0.0.1:5432/navigate`,NEWS_DRY_RUN:'false',NEWS_RUN_AT_BOOT:'false'});
// JSON quoting is accepted by both dotenv and systemd EnvironmentFile, including
// spaces and embedded #. Existing provider and notification settings are kept.
for(const [name,values] of [['content-api.env',api],['news-collector.env',collector]]){
  const content=Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n';
  fs.writeFileSync(`${shared}/${name}`,content,{mode:0o640,flag:'wx'});
}
fs.writeFileSync(`${shared}/news-database-owned`,JSON.stringify({database:'navigate',container:'agent-build-postgres',createdAt:new Date().toISOString()})+'\n',{mode:0o640,flag:'wx'});
console.log('Navigate roles, database and private environment files provisioned.');
