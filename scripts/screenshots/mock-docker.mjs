// A tiny stand-in for the Docker Engine API serving fictional homelab containers,
// so screenshots never show the real containers of whoever runs the script.
import { createServer } from 'node:http';

export function startMockDocker({ port, dbPort, user, password }) {
	const pg = (id, name, image, project, service, env, state = 'running', status = 'Up 3 weeks', published = true) => ({
		id,
		name,
		image,
		state,
		status,
		project,
		service,
		env,
		ports: published && state === 'running' ? { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(dbPort) }] } : {},
		networks: state === 'running' ? { [`${project}_default`]: { IPAddress: `172.31.${id.length}.2`, Aliases: [service] } } : {}
	});

	const containers = [
		pg('a1b2c3d4e5f6', 'immich_postgres', 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3', 'immich', 'database', {
			POSTGRES_USER: user,
			POSTGRES_PASSWORD: password,
			POSTGRES_DB: 'immich'
		}),
		pg('b2c3d4e5f6a1', 'gitea-db-1', 'postgres:16-alpine', 'gitea', 'db', {
			POSTGRES_USER: user,
			POSTGRES_PASSWORD: password,
			POSTGRES_DB: 'gitea'
		}),
		pg('c3d4e5f6a1b2', 'jellystat-db', 'postgres:17', 'jellystat', 'db', {
			POSTGRES_USER: user,
			POSTGRES_PASSWORD: password,
			POSTGRES_DB: 'media'
		}),
		pg(
			'd4e5f6a1b2c3',
			'paperless-db-1',
			'postgres:16',
			'paperless',
			'db',
			{ POSTGRES_USER: 'paperless', POSTGRES_PASSWORD_FILE: '/run/secrets/db_password', POSTGRES_DB: 'paperless' },
			'exited',
			'Exited (0) 2 days ago'
		),
		{
			id: 'e5f6a1b2c3d4',
			name: 'gitea',
			image: 'gitea/gitea:1.22',
			state: 'running',
			status: 'Up 3 weeks',
			project: 'gitea',
			service: 'server',
			env: {
				GITEA__database__DB_TYPE: 'postgres',
				DATABASE_URL: `postgres://${user}:${password}@db:5432/gitea`
			},
			ports: {},
			networks: { gitea_default: { IPAddress: '172.31.12.3', Aliases: ['server'] } }
		}
	];

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://docker');
		const send = (body, status = 200) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === '/containers/json') {
			return send(containers.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Image: c.image, State: c.state, Status: c.status })));
		}
		const m = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
		const c = m && containers.find((x) => x.id === m[1]);
		if (!c) return send({ message: 'not found' }, 404);
		send({
			Id: c.id,
			Name: `/${c.name}`,
			Config: {
				Image: c.image,
				Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
				Labels: { 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service }
			},
			NetworkSettings: { Ports: c.ports, Networks: c.networks }
		});
	});
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
