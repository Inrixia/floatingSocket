import { createServer as createTCPServer, type Socket } from "net";
import { createServer as createHttpServer, type Server } from "http";
import { writeFile } from "fs/promises";

const httpPorts = new Set<number>();
const updateTargets = () => {
	const targets: string[] = [];
	for (const httpPort of httpPorts) {
		targets.push(`floatingsocket:${httpPort}`);
	}
	return writeFile(
		"targets.json",
		JSON.stringify({
			targets,
			labels: {
				job: "fpd",
			},
		})
	);
};

const serverAddress = (httpServer: Server) => {
	const address = httpServer.address();
	if (address === null || typeof address === "string") throw new Error("Could not get address");
	return address;
};
enum ChangeType {
	Listening = "Listening",
	Closed = "Closed",
	Ended = "Ended",
}
const tcpServer = createTCPServer(async (socket) => {
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
			httpPorts.delete(port);
		} else httpPorts.add(port);
		console.log(`${type}: Client [${socketAddress}] <> HTTP [${httpAddress}]`);
		updateTargets();
	};

	httpServer.on("listening", onChange(ChangeType.Listening)).on("close", onChange(ChangeType.Closed));

	socket.on("end", onChange(ChangeType.Ended));
	socket.on("error", (err) => console.error(`Client ${socketAddress} socket error:`, err));
});

const tcpPort = 5000;
tcpServer.listen(tcpPort, () => console.log(`TCP Server listening on port ${tcpPort}`));
