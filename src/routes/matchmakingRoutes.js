const express = require("express");

function createMatchmakingRouter(matchmakingService, userService) {
    const router = express.Router();
    const handleError = (label, err, res) => {
        console.error(`${label}:`, err);

        if (err.message && err.message.startsWith("Unsupported mode:")) {
            return res.status(400).json({ error: err.message });
        }

        return res.status(500).json({ error: "Internal server error" });
    };

    router.post("/enqueue", async (req, res) => {
        try {
            const { userId, mode } = req.body;
            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            const normalizedMode = matchmakingService.normalizeMode(mode);
            const activeMode = await matchmakingService.getActiveModeForUser(userId);

            if (activeMode && activeMode !== normalizedMode) {
                return res.json({ status: "already_in_queue", mode: activeMode });
            }

            const pendingPair = await matchmakingService.getPendingPair(userId, normalizedMode);
            if (pendingPair) {
                return res.json({ status: "already_found", mode: normalizedMode });
            }

            const user = await userService.getUser(userId);
            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const result = await matchmakingService.enqueueUser(userId, user.rating, normalizedMode);
            return res.json({ ...result, mode: normalizedMode });
        } catch (err) {
            return handleError("Enqueue error", err, res);
        }
    });

    router.post("/check", async (req, res) => {
        try {
            const { userId, mode } = req.body;
            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            const normalizedMode = matchmakingService.normalizeMode(mode);

            if (normalizedMode === "PVE") {
                const queueMeta = await matchmakingService.getQueueMeta(userId, normalizedMode);
                if (!queueMeta) {
                    return res.json({ status: "not_in_queue", mode: normalizedMode });
                }

                return res.json({ status: "found", mode: normalizedMode, opponent: { userId: "bot", username: "Arena Bot", isBot: true } });
            }

            const pendingPair = await matchmakingService.getPendingPair(userId, normalizedMode);
            if (pendingPair) {
                const pending = pendingPair.data;
                const opponentId = pending.p1 === userId ? pending.p2 : pending.p1;
                const opponent = await userService.getUser(opponentId);

                return res.json({
                    status: "found",
                    mode: normalizedMode,
                    opponent: {
                        userId: opponent.userId,
                        username: opponent.username,
                        rating: opponent.rating,
                        level: opponent.level,
                    },
                });
            }

            const queueMeta = await matchmakingService.getQueueMeta(userId, normalizedMode);
            if (!queueMeta) {
                return res.json({ status: "not_in_queue", mode: normalizedMode });
            }

            const opponentId = await matchmakingService.findOpponent(userId, normalizedMode);
            if (!opponentId) {
                return res.json({ status: "searching", mode: normalizedMode });
            }

            const opponentAvailable = await matchmakingService.isAvailableForPairing(opponentId, normalizedMode);
            if (!opponentAvailable) {
                return res.json({ status: "searching", mode: normalizedMode });
            }

            await matchmakingService.createPendingPair(userId, opponentId, normalizedMode);

            const opponent = await userService.getUser(opponentId);

            return res.json({
                status: "found",
                mode: normalizedMode,
                opponent: {
                    userId: opponent.userId,
                    username: opponent.username,
                    rating: opponent.rating,
                    level: opponent.level,
                },
            });
        } catch (err) {
            return handleError("Check error", err, res);
        }
    });

    router.post("/match", async (req, res) => {
        try {
            const { userId, mode } = req.body;
            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            const normalizedMode = matchmakingService.normalizeMode(mode);
            const existing = await matchmakingService.checkExistingMatch(userId);
            if (existing) {
                return res.json({ status: "has_match", match: existing });
            }

            const result = await matchmakingService.acceptPair(userId, normalizedMode);
            return res.json({ ...result, mode: normalizedMode });
        } catch (err) {
            return handleError("Match error", err, res);
        }
    });

    router.post("/dequeue", async (req, res) => {
        try {
            const { userId, mode } = req.body;
            if (!userId) {
                return res.status(400).json({ error: "userId is required" });
            }

            const result = await matchmakingService.dequeueUser(userId, mode);
            return res.json(result);
        } catch (err) {
            return handleError("Dequeue error", err, res);
        }
    });

    return router;
}

module.exports = createMatchmakingRouter;
