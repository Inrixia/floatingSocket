import { createServer as createTCPServer } from "net";
import { createServer as createHttpServer, type Server } from "http";

import { WebSocketServer } from "ws";

const instances: Record<string, string> = {};
createHttpServer(async (req, res) => {
	try {
		switch (req.url) {
			case "/targets": {
				res.setHeader("Content-Type", "application/json");
				const targets = [];
				for (const target in instances) {
					targets.push({
						targets: [target],
						labels: {
							instance: instances[target],
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
	const httpServer = createHttpServer(async (req, res) => {
		try {
			if (req.url !== "/metrics" || !socket.OPEN) {
				res.statusCode = 404;
				res.end("Not found");
				if (!socket.OPEN) {
					httpServer.close();
					socket.close();
				}
			} else {
				const data = new Promise<void>((res) => {
					socket.once("message", res);
					setTimeout(res, 3000);
				});
				socket.send(".");
				res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
				res.end(await data);
			}
		} catch (err) {
			res.statusCode = 500;
			res.end((<Error>err)?.message);
		}
	}).listen(0);
	const { address, port } = serverAddress(httpServer);
	const onChange = (type: ChangeType) => () => {
		if (type !== ChangeType.Listening) {
			if (!socket.OPEN) socket.close();
			if (httpServer.listening) httpServer.close();
			delete instances[`floatingsocket:${port}`];
		} else instances[`floatingsocket:${port}`] = instance;
		console.log(`${type}: Client [${req.socket.remoteAddress}:${req.socket.remotePort}] <> HTTP [${address}:${port}]`);
	};

	httpServer.on("listening", onChange(ChangeType.Listening)).on("close", onChange(ChangeType.Closed)).on("error", onChange(ChangeType.Error));
	socket.on("end", onChange(ChangeType.Ended)).on("error", onChange(ChangeType.Error));
});
