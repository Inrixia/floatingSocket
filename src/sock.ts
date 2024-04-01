import { createServer as createTCPServer, type Socket } from "net";
import { createServer as createHttpServer } from "http";
import { AggregatorRegistry } from "prom-client";

const tcpSockets = new Set<Socket>();
const tcpServer = createTCPServer((socket) => {
	tcpSockets.add(socket);
	const socketAddress = `${socket.remoteAddress}:${socket.remotePort}`;
	console.log(`Client ${socketAddress} connected!`);
	socket.on("end", () => {
		tcpSockets.delete(socket);
		console.log(`Client ${socketAddress} disconnected.`);
	});
	socket.on("error", (err) => console.error(`Client ${socketAddress} socket error:`, err));
});

const socketRequestTimeout = 3000;
const socketMetrics = async () => {
	const results: Object[] = [];
	for (const sock of tcpSockets) {
		if (sock.writable) {
			results.push(
				new Promise<void>((res) => {
					sock.once("data", (data) => {
						try {
							res(JSON.parse(data.toString()));
						} catch {}
					});
					setTimeout(res, socketRequestTimeout);
				})
			);
			sock.write(".");
			continue;
		}
		tcpSockets.delete(sock);
	}
	return AggregatorRegistry.aggregate((await Promise.all(results)).filter((result) => result !== undefined));
};

const httpServer = createHttpServer(async (req, res) => {
	if (req.url === "/metrics") {
		try {
			const register = await socketMetrics();
			res.setHeader("Content-Type", register.contentType);
			res.end(await register.metrics());
		} catch (err) {
			res.statusCode = 500;
			res.end((<Error>err)?.message);
		}
	} else {
		res.statusCode = 404;
		res.end("Not found");
	}
});

const httpPort = 80;
httpServer.listen(httpPort, () => console.log(`HTTP server listening on port ${httpPort}`));

const tcpPort = 5000;
tcpServer.listen(tcpPort, () => console.log(`TCP Server listening on port ${tcpPort}`));

const gracefulShutdown = () => {
	tcpServer.close();
	httpServer.close();
};
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
