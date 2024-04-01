import { createServer as createTCPServer } from "net";
import { createServer as createHttpServer, type Server } from "http";

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
const tcpServer = createTCPServer(async (socket) => {
	const instance: string = await new Promise((res) => socket.once("data", (data) => res(data.toString())));
	const httpServer = createHttpServer(async (req, res) => {
		try {
			if (req.url !== "/metrics" || !socket.writable) {
				res.statusCode = 404;
				res.end("Not found");
				if (!socket.writable) {
					httpServer.close();
					socket.destroy();
				}
			} else {
				const data = new Promise<void>((res) => {
					socket.once("data", res);
					setTimeout(res, 3000);
				});
				socket.write(".");
				res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
				res.end(await data);
			}
		} catch (err) {
			res.statusCode = 500;
			res.end((<Error>err)?.message);
		}
	}).listen(0);

	const { address, port } = serverAddress(httpServer);
	const httpAddress = `${address}:${port}`;
	const socketAddress = `${socket.remoteAddress}:${socket.remotePort}`;
	const onChange = (type: ChangeType) => () => {
		if (type !== ChangeType.Listening) {
			if (!socket.destroyed) socket.destroy();
			if (httpServer.listening) httpServer.close();
			delete instances[`floatingsocket:${port}`];
		} else instances[`floatingsocket:${port}`] = instance;
		console.log(`${type}: Client [${socketAddress}] <> HTTP [${httpAddress}]`);
	};

	httpServer.on("listening", onChange(ChangeType.Listening)).on("close", onChange(ChangeType.Closed)).on("error", onChange(ChangeType.Error));
	socket.on("end", onChange(ChangeType.Ended)).on("error", onChange(ChangeType.Error));
});

const tcpPort = process.env.TCP_SOCKET_PORT || 5000;
tcpServer.listen(tcpPort, () => console.log(`TCP Server listening on port ${tcpPort}`));
