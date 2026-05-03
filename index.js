import http from "node:http";
import express from "express";
import path from "path";
import { Server } from "socket.io";
import { publisher, redis, subscriber } from "./redis-connection.js";
import JWT from "jsonwebtoken";
import JwksClient from "jwks-rsa";
import cookieParser from "cookie-parser";

const CHECKBOX_SIZE = 100;
const CHECKBOX_STATE_KEY = "checkbox-state";
const AUTH_SERVER = "http://localhost:8000";
const APP_PORT = process.env.PORT ?? 3000;

const jwksClient = JwksClient({
    jwksUri: `${AUTH_SERVER}/.well-known/jwks.json`,
    cache: true,
    rateLimit: true,
});

async function verifyToken(token) {
    const decoded = JWT.decode(token, { complete: true });
    if (!decoded) throw new Error("Invalid token");
    const key = await jwksClient.getSigningKey(decoded.header.kid);
    return JWT.verify(token, key.getPublicKey(), { algorithms: ["RS256"] });
}

function requireAuth(req, res, next) {
    const token = req.cookies?.token;
    if (!token) {
        return res.redirect(
            `${AUTH_SERVER}/o/authenticate?redirect_uri=http://localhost:${APP_PORT}/auth/callback`,
        );
    }
    try {
        req.user = JWT.decode(token);
        next();
    } catch {
        res.clearCookie("token");
        res.redirect(`${AUTH_SERVER}/o/authenticate`);
    }
}

async function main() {
    const PORT = process.env.PORT ?? 8000;
    const app = express();
    const server = http.createServer(app);

    const io = new Server();
    io.attach(server);

    app.use(cookieParser());

    // Auth routes — before static middleware
    app.get("/auth/callback", async (req, res) => {
        const { token } = req.query;
        if (!token) return res.redirect("/");

        try {
            await verifyToken(token);
            res.cookie("token", token, { httpOnly: true, maxAge: 3600 * 1000 });
            res.redirect("/");
        } catch {
            res.status(401).send("Invalid token");
        }
    });

    app.get("/auth/logout", (req, res) => {
        res.clearCookie("token");
        res.redirect(`${AUTH_SERVER}/o/authenticate`);
    });

    // Static files and protected routes
    app.use(requireAuth, express.static(path.resolve("./public")));

    await subscriber.subscribe("internal-server:checkbox:change");
    subscriber.on("message", (channel, message) => {
        if (channel === "internal-server:checkbox:change") {
            const { index, checked } = JSON.parse(message);

            io.emit("server:checkbox:change", { index, checked });
        }
    });

    // Socket io handler

    io.on("connection", (socket) => {
        console.log("Socket connected", { id: socket.id });

        let eventCount = 0;
        const LIMIT = 10; // max events
        const WINDOW = 5000; // per 1 second

        const resetInterval = setInterval(() => {
            eventCount = 0;
        }, WINDOW);

        socket.on("client:checkbox:change", async (data) => {
            console.log(`[Socket:${socket.id}]`, data);
            eventCount++;
            if (eventCount > LIMIT) {
                socket.emit("rate:limited"); // tell client
                return;
            }

            const existingState = await redis.get(CHECKBOX_STATE_KEY);

            if (existingState) {
                const remoteData = JSON.parse(existingState);
                remoteData[data.index] = data.checked;
                await redis.set(CHECKBOX_STATE_KEY, JSON.stringify(remoteData));
            } else {
                await redis.set(
                    CHECKBOX_STATE_KEY,
                    JSON.stringify(new Array(CHECKBOX_SIZE).fill(false)),
                );
            }

            await publisher.publish(
                "internal-server:checkbox:change",
                JSON.stringify(data),
            );
        });

        socket.on("disconnect", () => {
            clearInterval(resetInterval); // cleanup, important
        });
    });

    // Express

    app.get("/health", (req, res) => res.json({ healthy: true }));

    app.get("/checkboxes", async (req, res) => {
        const existingState = await redis.get(CHECKBOX_STATE_KEY);
        if (existingState) {
            const remoteData = JSON.parse(existingState);
            return res.json({ checkboxes: remoteData });
        }
        return res.json({ checkboxes: new Array(CHECKBOX_SIZE).fill(false) });
    });

    server.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

main();
