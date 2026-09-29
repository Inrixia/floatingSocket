import { createServer as createHttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";

type InstanceInfo = {
	ip?: string;
	id: string;
	socket?: WebSocket;
	isFetching?: boolean;
};
const instances: Record<string, InstanceInfo> = {};
// A single central HTTP router handles both Service Discovery and Metrics proxying
createHttpServer(async (req, res) => {
	if (req.url === undefined) throw new Error("Invalid request.");
	try {
		const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

		// Service Discovery Endpoint
		if (url.pathname === "/targets") {
			res.setHeader("Content-Type", "application/json");
			const targets = [];

			for (const instance in instances) {
				const { ip, id } = instances[instance];
				targets.push({
					// Route all Prometheus scrapes back to this exact server
					targets: [req.headers.host || "floatingsocket"],
					labels: {
						// Instruct Prometheus to use a unique path for this specific client
						__metrics_path__: `/metrics/${instance}`,
						ip,
						id,
						instance,
					},
				});
			}
			res.end(JSON.stringify(targets));
			return;
		}

		// Metrics Proxy Endpoint
		if (url.pathname.startsWith("/metrics/")) {
			const instance = decodeURIComponent(url.pathname.replace("/metrics/", ""));
			const target = instances[instance];

			if (!target || !target.socket || target.socket.readyState !== WebSocket.OPEN) {
				res.statusCode = 404;
				res.end("Not found or offline");
				return;
			}

			// Concurrency Lock: Prevent multiple overlapping '.once' listeners on the same socket
			if (target.isFetching) {
				res.statusCode = 429;
				res.end("Too Many Requests - Already fetching");
				return;
			}

			target.isFetching = true;
			const socket = target.socket;

			const deadSocketTimeout = setTimeout(() => {
				target.isFetching = false;
				socket.terminate();
				console.warn(`Client socket [${target.id}] timeout`);
				if (!res.closed) {
					res.statusCode = 504;
					res.end("Gateway Timeout");
				}
			}, 4000);

			socket.once("message", (data) => {
				clearTimeout(deadSocketTimeout);
				target.isFetching = false;

				if (!res.closed) {
					res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
					res.end(data);
				}
			});

			socket.ping();
			return;
		}

		res.statusCode = 404;
		res.end("Not found");
	} catch (err) {
		console.error(err);
		if (!res.closed) {
			res.statusCode = 500;
			res.end((err as Error)?.message);
		}
	}
}).listen(process.env.SERVICE_DISCOVERY_PORT || 80);

// WebSocket

// Rate Limiting
const seenIps = new Set<string>();
setInterval(seenIps.clear.bind(seenIps), 45000);

const webSocketPort = process.env.WEB_SOCKET_PORT || 5000;
new WebSocketServer({ port: +webSocketPort }).on("connection", async (newSocket, req) => {
	try {
		const ip = req.headers["x-forwarded-for"]?.toString() ?? req.socket.remoteAddress;

		// Rate Limiting
		if (ip === undefined || seenIps.has(ip)) return setTimeout(newSocket.terminate.bind(newSocket), 60000);
		seenIps.add(ip);

		// Basic timeout protection so broken connections don't leak un-resolved Promises
		const id = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("ID timeout")), 5000);
			newSocket.once("message", (data) => {
				clearTimeout(timeout);
				resolve(data.toString());
			});
		});

		const instance = `${id}:${ip}`;
		if (instances[instance]?.socket) instances[instance].socket?.terminate();
		instances[instance] = { ip, id, socket: newSocket };
		console.log(`Connected: Client [${ip}:${req.socket.remotePort}] as ${instance}`);

		const onClose = (err?: Error) => {
			// Only delete if the active socket matches the one closing (prevents race condition on reconnects)
			if (instances[instance]?.socket === newSocket) delete instances[instance];
			if (newSocket.readyState === WebSocket.OPEN || newSocket.readyState === WebSocket.CONNECTING) newSocket.terminate();
			console.warn(`Client socket [${ip}:${req.socket.remotePort}] closed` + (err ? ` <> Err [${err}]` : ""));
		};

		newSocket.on("close", onClose).on("error", onClose);
	} catch {
		return newSocket.terminate();
	}
});

// Fix for docker
process.on("SIGTERM", process.exit);
