import { createServer as createHttpServer, type Server } from "http";
import { WebSocketServer, type WebSocket } from "ws";

type InstanceInfo = {
	target: string;
	ip?: string;
	socket?: WebSocket;
};
const instances: Record<string, InstanceInfo> = {};
createHttpServer(async (req, res) => {
	try {
		switch (req.url) {
			case "/targets": {
				res.setHeader("Content-Type", "application/json");
				const targets = [];
				for (const instanceId in instances) {
					const { target, ip } = instances[instanceId];
					targets.push({
						targets: [target],
						labels: {
							ip,
							instanceId,
						},
					});
				}
				res.end(JSON.stringify(targets));
				break;
			}
			case "/metrics":
			default: {
				res.statusCode = 404;
				res.end("Not found");
			}
		}
	} catch (err) {
		res.statusCode = 500;
		res.end((<Error>err)?.message);
	}
}).listen(process.env.SERVICE_DISCOVERY_PORT || 80);

const serverAddress = (httpServer: Server) => {
	const address = httpServer.address();
	if (address === null || typeof address === "string") throw new Error("Could not get address");
	return address;
};
enum ChangeType {
	Listening = "Listening",
	Closed = "Closed",
	Ended = "Ended",
	Error = "Error",
}

const webSocketPort = process.env.WEB_SOCKET_PORT || 5000;
new WebSocketServer({ port: +webSocketPort }).on("connection", async (socket, req) => {
	const instance: string = await new Promise((res) => socket.once("message", (data) => res(data.toString())));

	const httpServer = createHttpServer((req, res) => {
		try {
			if (req.url !== "/metrics" || !socket.OPEN) {
				res.statusCode = 404;
				if (!socket.OPEN) {
					httpServer.close();
					socket.close();
				}
			} else {
				const deadSocketTimeout = setTimeout(() => {
					res.statusCode = 504;
					res.end();
					httpServer.close();
					socket.close();
				}, 4000);
				socket.once("message", (data) => {
					clearTimeout(deadSocketTimeout);
					if (httpServer.listening) {
						res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
						res.end(data);
					}
				});
				socket.ping();
			}
		} catch (err) {
			if (!res.closed) {
				res.statusCode = 500;
				res.end((<Error>err)?.message);
			}
		}
	}).listen(0);

	const { address, port } = serverAddress(httpServer);
	const onChange = (type: ChangeType) => (err: Error) => {
		const ip = req.headers["x-forwarded-for"]?.toString() ?? req.socket.remoteAddress;
		if (type === ChangeType.Listening) {
			// Ensure the instance is only connected once
			// instances[instance]?.socket?.terminate(); Disabled to avoid reconnect thrashing
			instances[instance] = { ip, socket, target: `floatingsocket:${port}` };
		} else {
			delete instances[instance];
			try {
				socket.terminate();
			} catch {}
			try {
				httpServer.close();
			} catch {}
		}
		console.log(`${type}: Client [${ip}:${req.socket.remotePort}] <> HTTP [${address}:${port}]`);
		if (err) console.error(err);
	};

	httpServer
		.on("listening", onChange(ChangeType.Listening))
		.on("close", onChange(ChangeType.Closed))
		.on("error", onChange(ChangeType.Error))
		.on("clientError", console.error);

	socket.on("close", onChange(ChangeType.Closed)).on("error", onChange(ChangeType.Error));
});

// Fix for docker
process.on("SIGTERM", process.exit);
