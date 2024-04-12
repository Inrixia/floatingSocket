import { createServer as createHttpServer, type Server } from "http";

import { WebSocketServer } from "ws";

type InstanceInfo = {
	instance: string;
	ip?: string;
};
const instances: Record<string, InstanceInfo> = {};
createHttpServer(async (req, res) => {
	try {
		switch (req.url) {
			case "/targets": {
				res.setHeader("Content-Type", "application/json");
				const targets = [];
				for (const target in instances) {
					targets.push({
						targets: [target],
						labels: instances[target],
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
const behindTunnel = process.env.BEHIND_TUNNEL === "true";
new WebSocketServer({ port: +webSocketPort }).on("connection", async (socket, req) => {
	const instance: string = await new Promise((res) => socket.once("message", (data) => res(data.toString())));
	const httpServer = createHttpServer(async (req, res) => {
		try {
			if (req.url !== "/metrics" || !socket.OPEN) {
				res.statusCode = 404;
				if (!socket.OPEN) {
					httpServer.close();
					socket.close();
				}
			} else {
				const data = new Promise<void>((res, rej) => {
					socket.once("message", res);
					setTimeout(rej, 10000);
				});
				const pingInterval = setInterval(socket.ping.bind(socket), 1000);
				data.finally(() => clearInterval(pingInterval));
				res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
				res.end(await data);
			}
		} catch (err) {
			res.statusCode = 500;
			res.end((<Error>err)?.message);
		}
	}).listen(0);
	const { address, port } = serverAddress(httpServer);

	const close = () => {
		if (socket.readyState !== socket.OPEN) socket.close();
		if (httpServer.listening) httpServer.close();
		delete instances[`floatingsocket:${port}`];
	};
	const onChange = (type: ChangeType) => () => {
		const remoteAddress = behindTunnel ? req.headers["x-forwarded-for"]?.toString() : req.socket.remoteAddress;
		if (type !== ChangeType.Listening) close();
		else instances[`floatingsocket:${port}`] = { instance, ip: remoteAddress };
		console.log(`${type}: Client [${remoteAddress}:${req.socket.remotePort}] <> HTTP [${address}:${port}]`);
	};

	httpServer
		.on("listening", onChange(ChangeType.Listening))
		.on("close", onChange(ChangeType.Closed))
		.on("error", onChange(ChangeType.Error))
		.on("clientError", console.log);

	socket.on("close", onChange(ChangeType.Closed)).on("error", onChange(ChangeType.Error));
});

// Fix for docker
process.on("SIGTERM", process.exit);
