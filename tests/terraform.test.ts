import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HclExpr, parseHcl, terraformCandidates } from '../src/lib/server/discovery/terraform.ts';

const summary = (c: { user: string; password?: string; host: string; port: number; database: string }) =>
	`${c.user}:${c.password ?? ''}@${c.host}:${c.port}/${c.database}`;

test('HCL: blocks, labels, comments, lists, objects, nested blocks and heredocs', () => {
	const body = parseHcl(`
# a comment
// another
/* block
   comment */
resource "docker_container" "db" {
  name  = "pg"   # trailing comment
  count = 1
  env   = ["A=1", "B=\${var.b}",
    "C=x", ]
  labels = { team = "infra", "app.kind" = "db" }
  enabled = true
  missing = null
  image = docker_image.pg.image_id
  cmd   = var.on ? "a" : "b"
  ports {
    internal = 5432
    external = 5433
  }
  script = <<-EOF
    line one
      indented
    EOF
}
locals { x = 1 }
`);
	assert.equal(body.blocks.length, 2);
	const [r, l] = body.blocks;
	assert.equal(r.type, 'resource');
	assert.deepEqual(r.labels, ['docker_container', 'db']);
	assert.equal(r.body.attrs.name, 'pg');
	assert.equal(r.body.attrs.count, 1);
	assert.deepEqual(r.body.attrs.env, ['A=1', 'B=${var.b}', 'C=x']);
	assert.deepEqual(r.body.attrs.labels, { team: 'infra', 'app.kind': 'db' });
	assert.equal(r.body.attrs.enabled, true);
	assert.equal(r.body.attrs.missing, null);
	assert.ok(r.body.attrs.image instanceof HclExpr);
	assert.equal((r.body.attrs.image as HclExpr).text, 'docker_image.pg.image_id');
	assert.equal((r.body.attrs.cmd as HclExpr).text, 'var.on ? "a" : "b"');
	assert.equal(r.body.blocks[0].type, 'ports');
	assert.equal(r.body.blocks[0].body.attrs.external, 5433);
	assert.equal(r.body.attrs.script, 'line one\n  indented\n');
	assert.deepEqual(l.body.attrs, { x: 1 });
});

test('HCL: single-line blocks, escapes and nested templates', () => {
	const body = parseHcl('ports { internal = 5432 external = 5433 }\nx = "a\\"b ${lookup(m, "k}")} c"\n');
	assert.deepEqual(body.blocks[0].body.attrs, { internal: 5432, external: 5433 });
	assert.equal(body.attrs.x, 'a"b ${lookup(m, "k}")} c');
});

test('HCL: malformed input never throws and keeps what parsed', () => {
	const inputs = ['resource "a" "b" {\n  x = "unterminated\n  y = [1, 2\n', '}}}{{{ = = "', 'a = <<EOF\nno end', '/* open comment', 'x = (1 + \n'];
	for (const src of inputs) assert.doesNotThrow(() => parseHcl(src));
	const partial = parseHcl('provider "postgresql" {\n  host = "db"\n  port = \n  oops oops oops\n  username = "u"\n');
	assert.equal(partial.blocks[0].body.attrs.host, 'db');
	assert.equal(partial.blocks[0].body.attrs.username, 'u');
	assert.doesNotThrow(() =>
		terraformCandidates(
			[
				{ path: '/m/main.tf', content: 'resource "docker_container" {{{ env = [' },
				{ path: '/m/terraform.tfstate', content: '{ not json' },
				{ path: '/m/x.tfvars.json', content: '[1' }
			],
			{ project: 'm' }
		)
	);
});

test('postgresql provider with variables from tfvars (auto.tfvars wins) and defaults', () => {
	const out = terraformCandidates(
		[
			{
				path: '/infra/pg/main.tf',
				content: `
variable "pg_host" { default = "db.lan" }
variable "pg_password" {
  type      = string
  sensitive = true
}
variable "pg_port" { default = 5432 }
locals {
  admin = "admin_\${var.env}"
}
provider "postgresql" {
  host     = var.pg_host
  port     = var.pg_port
  username = local.admin
  password = var.pg_password
  database = "app"
  sslmode  = "require"
}
`
			},
			{ path: '/infra/pg/terraform.tfvars', content: 'pg_password = "from-tfvars"\nenv = "prod"\npg_port = 6543\n' },
			{ path: '/infra/pg/secrets.auto.tfvars', content: 'pg_password = "from-auto"\n' }
		],
		{ project: 'pg' }
	);
	assert.equal(out.length, 1);
	assert.equal(summary(out[0]), 'admin_prod:from-auto@db.lan:6543/app');
	assert.equal(out[0].sslMode, 'require');
	assert.equal(out[0].source.kind, 'terraform');
	assert.equal(out[0].source.ref, '/infra/pg/secrets.auto.tfvars');
});

test('unresolvable variables become notes', () => {
	const [c] = terraformCandidates(
		[{ path: '/m/main.tf', content: 'variable "db_password" {}\nprovider "postgresql" {\n  host = "10.0.0.2"\n  password = var.db_password\n}\n' }],
		{ project: 'm' }
	);
	assert.equal(c.hasPassword, false);
	assert.equal(c.database, 'postgres');
	assert.equal(c.user, 'postgres');
	assert.match(c.notes.join(' '), /var\.db_password, which has no value in this folder/);
	assert.equal(c.source.ref, '/m/main.tf');
});

test('postgresql_role with login gets its owned database', () => {
	const out = terraformCandidates(
		[
			{
				path: '/m/main.tf',
				content: `
provider "postgresql" {
  host = "pg.lan"
  username = "postgres"
  password = "root"
}
resource "postgresql_role" "app" {
  name     = "app"
  login    = true
  password = "app-pw"
}
resource "postgresql_role" "group" {
  name = "readers"
}
resource "postgresql_database" "app" {
  name  = "appdb"
  owner = postgresql_role.app.name
}
`
			}
		],
		{ project: 'm' }
	);
	assert.deepEqual(out.map(summary).sort(), ['app:app-pw@pg.lan:5432/appdb', 'postgres:root@pg.lan:5432/postgres']);
});

test('docker_container: server with published port, image via docker_image, and an app pointing at it', () => {
	const out = terraformCandidates(
		[
			{
				path: '/stacks/wiki/main.tf',
				content: `
resource "docker_image" "pg" {
  name = "postgres:16-alpine"
}
resource "docker_container" "db" {
  name  = "wiki-db"
  image = docker_image.pg.image_id
  env = [
    "POSTGRES_USER=wiki",
    "POSTGRES_PASSWORD=\${var.db_password}",
    "POSTGRES_DB=wiki",
  ]
  ports {
    internal = 5432
    external = 5433
  }
}
resource "docker_container" "app" {
  name  = "wiki"
  image = "ghcr.io/requarks/wiki:2"
  env = ["DB_TYPE=postgres", "DB_HOST=wiki-db", "DB_USER=wiki", "DB_PASS=\${var.db_password}", "DB_NAME=wiki"]
}
`
			},
			{ path: '/stacks/wiki/terraform.tfvars', content: 'db_password = "s3cret" # comment\n' }
		],
		{ project: 'wiki' }
	);
	const db = out.find((c) => c.name === 'wiki/wiki-db')!;
	assert.equal(summary(db), 'wiki:s3cret@localhost:5433/wiki');
	assert.deepEqual(db.alternates?.map((a) => `${a.host}:${a.port}`), ['wiki-db:5432']);
	assert.equal(db.source.ref, '/stacks/wiki/terraform.tfvars');
	// The app's candidate collapses into the server's (same fingerprint).
	assert.equal(out.length, 1);
});

test('docker_container app with DATABASE_URL and an unpublished server', () => {
	const out = terraformCandidates(
		[
			{
				path: '/m/main.tf',
				content: `
provider "docker" { host = "ssh://me@10.0.0.9" }
resource "docker_container" "api" {
  name  = "api"
  image = "example/api"
  env   = ["DATABASE_URL=postgres://api:pw@db.example.com:5432/api"]
}
resource "docker_container" "pg" {
  image = "postgres:17"
  env   = ["POSTGRES_PASSWORD=x"]
}
resource "docker_container" "pub" {
  name = "pub"
  image = "postgis/postgis"
  env = ["POSTGRES_PASSWORD=y"]
  ports { internal = 5432 external = 15432 }
}
`
			}
		],
		{ project: 'm' }
	);
	assert.ok(out.some((c) => summary(c) === 'api:pw@db.example.com:5432/api'));
	const pg = out.find((c) => c.name === 'm/pg')!;
	assert.equal(pg.host, 'pg');
	assert.match(pg.notes.join(' '), /No published port/);
	assert.equal(summary(out.find((c) => c.name === 'm/pub')!), 'postgres:y@10.0.0.9:15432/postgres');
});

test('postgres URLs anywhere, including nested maps and heredocs', () => {
	const out = terraformCandidates(
		[
			{
				path: '/k8s/main.tf',
				content: `
resource "kubernetes_secret" "app" {
  metadata { name = "app" }
  data = {
    DATABASE_URL = "postgresql://svc:\${random_password.svc.result}@pg.k8s:5432/svc?sslmode=require"
  }
}
resource "helm_release" "x" {
  values = [<<EOT
db:
  url: postgres://helm:hp@pg.k8s/helm
EOT
  ]
}
`
			}
		],
		{ project: 'k8s' }
	);
	const svc = out.find((c) => c.user === 'svc')!;
	assert.equal(svc.hasPassword, false);
	assert.equal(svc.sslMode, 'require');
	assert.match(svc.notes.join(' '), /random_password\.svc\.result, which is only known after/);
	assert.equal(summary(out.find((c) => c.user === 'helm')!), 'helm:hp@pg.k8s:5432/helm');
});

test('terraform.tfstate: generated passwords, aws_db_instance and docker containers', () => {
	const state = {
		version: 4,
		resources: [
			{
				mode: 'managed',
				type: 'aws_db_instance',
				name: 'main',
				instances: [
					{
						attributes: {
							engine: 'postgres',
							address: 'main.abc.eu-west-1.rds.amazonaws.com',
							endpoint: 'main.abc.eu-west-1.rds.amazonaws.com:5432',
							port: 5432,
							username: 'master',
							password: 'rds-pw',
							db_name: 'core'
						}
					}
				]
			},
			{ mode: 'managed', type: 'aws_db_instance', name: 'mysql', instances: [{ attributes: { engine: 'mysql', address: 'm', username: 'x' } }] },
			{ mode: 'managed', type: 'random_password', name: 'svc', instances: [{ attributes: { result: 'generated' } }] },
			{ mode: 'managed', type: 'docker_image', name: 'pg', instances: [{ attributes: { name: 'postgres:16', image_id: 'sha256:abc' } }] },
			{
				mode: 'managed',
				type: 'docker_container',
				name: 'db',
				instances: [
					{
						attributes: {
							name: 'statedb',
							image: 'sha256:abc',
							env: ['POSTGRES_USER=s'],
							ports: [{ internal: 5432, external: 5999, ip: '0.0.0.0', protocol: 'tcp' }]
						}
					}
				]
			}
		]
	};
	const out = terraformCandidates(
		[
			{ path: '/m/terraform.tfstate', content: JSON.stringify(state) },
			{ path: '/m/main.tf', content: 'provider "postgresql" {\n  host = "h"\n  password = random_password.svc.result\n}\n' }
		],
		{ project: 'm' }
	);
	const rds = out.find((c) => c.name.includes('aws_db_instance.main'))!;
	assert.equal(summary(rds), 'master:rds-pw@main.abc.eu-west-1.rds.amazonaws.com:5432/core');
	assert.equal(rds.source.ref, '/m/terraform.tfstate');
	assert.ok(!out.some((c) => c.name.includes('mysql')));
	assert.equal(summary(out.find((c) => c.name.includes('provider'))!), 'postgres:generated@h:5432/postgres');
	assert.equal(summary(out.find((c) => c.name === 'm/statedb')!), 's:@localhost:5999/s');
});
