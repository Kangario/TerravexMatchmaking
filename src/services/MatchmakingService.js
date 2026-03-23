const {
    MATCH_MODES,
    MATCH_SEARCH_STEP_MS,
    MATCH_SEARCH_RANGE_STEP,
    FULL_QUEUE_SEARCH_AFTER_MS,
} = require("../config/constants");

class MatchmakingService {
    constructor(mmRedis, userService, gameServerService) {
        this.mmRedis = mmRedis;
        this.userService = userService;
        this.gameServerService = gameServerService;
    }

    normalizeMode(mode) {
        const normalizedMode = `${mode || MATCH_MODES.PVP}`.toUpperCase();

        if (!Object.values(MATCH_MODES).includes(normalizedMode)) {
            throw new Error(`Unsupported mode: ${mode}`);
        }

        return normalizedMode;
    }

    getQueueKey(mode) {
        return `mm:queue:${mode}:rating`;
    }

    getQueueMetaKey(mode, userId) {
        return `mm:queue:${mode}:meta:${userId}`;
    }

    getPendingUserKey(mode, userId) {
        return `mm:user:${mode}:pending:${userId}`;
    }

    getUserMatchKey(userId) {
        return `mm:user:match:${userId}`;
    }

    async getQueueMeta(userId, mode) {
        const raw = await this.mmRedis.get(this.getQueueMetaKey(mode, userId));
        return raw ? JSON.parse(raw) : null;
    }

    async getPendingPair(userId, mode) {
        const pairKey = await this.mmRedis.get(this.getPendingUserKey(mode, userId));
        if (!pairKey) return null;

        const raw = await this.mmRedis.get(pairKey);
        if (!raw) {
            await this.mmRedis.del(this.getPendingUserKey(mode, userId));
            return null;
        }

        return { key: pairKey, data: JSON.parse(raw) };
    }

    async getActiveModeForUser(userId) {
        for (const mode of Object.values(MATCH_MODES)) {
            const [queueMeta, pendingPair] = await Promise.all([
                this.getQueueMeta(userId, mode),
                this.getPendingPair(userId, mode),
            ]);

            if (queueMeta || pendingPair) {
                return mode;
            }
        }

        return null;
    }

    async isAvailableForPairing(userId, mode) {
        const pendingPair = await this.getPendingPair(userId, mode);
        return pendingPair === null;
    }

    async enqueueUser(userId, rating, mode) {
        const existingMeta = await this.getQueueMeta(userId, mode);

        if (existingMeta) {
            return { status: "already_in_queue" };
        }

        if (mode === MATCH_MODES.PVE) {
            await this.mmRedis.set(this.getQueueMetaKey(mode, userId), JSON.stringify({
                rating,
                joinedAt: Date.now(),
            }));
            return { status: "queued" };
        }

        const exists = await this.mmRedis.zScore(this.getQueueKey(mode), userId);
        if (exists !== null) {
            return { status: "already_in_queue" };
        }

        const now = Date.now();

        await this.mmRedis.set(this.getQueueMetaKey(mode, userId), JSON.stringify({
            rating,
            joinedAt: now,
        }));

        await this.mmRedis.zAdd(this.getQueueKey(mode), [
            { score: rating, value: userId },
        ]);

        return { status: "queued" };
    }

    async findOpponent(userId, mode) {
        const meta = await this.getQueueMeta(userId, mode);
        if (!meta) return null;

        const waitTime = Date.now() - meta.joinedAt;
        const step = Math.floor(waitTime / MATCH_SEARCH_STEP_MS);
        const range = step * MATCH_SEARCH_RANGE_STEP;
        const minRating = meta.rating - range;
        const maxRating = meta.rating + range;

        let candidateIds = await this.mmRedis.zRangeByScore(
            this.getQueueKey(mode),
            minRating,
            maxRating
        );

        if (waitTime >= FULL_QUEUE_SEARCH_AFTER_MS) {
            candidateIds = await this.mmRedis.zRange(this.getQueueKey(mode), 0, -1);
        }

        const candidates = [];

        for (const candidateId of candidateIds) {
            if (candidateId === userId) continue;
            if (!(await this.isAvailableForPairing(candidateId, mode))) continue;

            const candidateMeta = await this.getQueueMeta(candidateId, mode);
            if (!candidateMeta) continue;

            candidates.push({
                userId: candidateId,
                rating: candidateMeta.rating,
                joinedAt: candidateMeta.joinedAt,
                ratingDelta: Math.abs(candidateMeta.rating - meta.rating),
            });
        }

        candidates.sort((left, right) => {
            if (left.ratingDelta !== right.ratingDelta) {
                return left.ratingDelta - right.ratingDelta;
            }

            return left.joinedAt - right.joinedAt;
        });

        return candidates[0]?.userId || null;
    }

    async createPendingPair(p1, p2, mode) {
        const pairKey = `mm:pair:${mode}:${[p1, p2].sort().join(":")}`;
        const pending = { p1, p2, accepted: [], mode };

        const created = await this.mmRedis.set(
            pairKey,
            JSON.stringify(pending),
            { NX: true }
        );

        await this.mmRedis.set(this.getPendingUserKey(mode, p1), pairKey);
        await this.mmRedis.set(this.getPendingUserKey(mode, p2), pairKey);

        return created === null ? pairKey : pairKey;
    }

    async checkExistingMatch(userId) {
        const matchId = await this.mmRedis.get(this.getUserMatchKey(userId));
        if (!matchId) return null;

        const match = await this.gameServerService.getMatch(matchId);
        if (!match) {
            await this.mmRedis.del(this.getUserMatchKey(userId));
            return null;
        }

        return match;
    }

    async acceptPair(userId, mode) {
        if (mode === MATCH_MODES.PVE) {
            const queueMeta = await this.getQueueMeta(userId, mode);
            if (!queueMeta) {
                return { status: "no_pending" };
            }

            const user = await this.userService.getUser(userId);
            if (!user) {
                throw new Error(`User ${userId} not found`);
            }

            const match = await this.createPveMatch(user);
            await this.mmRedis.del(this.getQueueMetaKey(mode, userId));
            return { status: "match_created", match };
        }

        const pendingPair = await this.getPendingPair(userId, mode);
        if (!pendingPair) return { status: "no_pending" };

        const { key: pairId, data: pending } = pendingPair;

        if (!pending.accepted.includes(userId)) {
            pending.accepted.push(userId);
            await this.mmRedis.set(pairId, JSON.stringify(pending));
        }

        if (pending.accepted.length < 2) {
            return { status: "waiting_other" };
        }

        const match = await this.createPvpMatch(pending.p1, pending.p2, mode);

        await this.mmRedis.del(pairId);
        await this.mmRedis.del(this.getPendingUserKey(mode, pending.p1));
        await this.mmRedis.del(this.getPendingUserKey(mode, pending.p2));

        return { status: "match_created", match };
    }

    async createPvpMatch(playerOneId, playerTwoId, mode) {
        await this.mmRedis.zRem(this.getQueueKey(mode), playerOneId);
        await this.mmRedis.zRem(this.getQueueKey(mode), playerTwoId);
        await this.mmRedis.del(this.getQueueMetaKey(mode, playerOneId));
        await this.mmRedis.del(this.getQueueMetaKey(mode, playerTwoId));

        const [firstUser, secondUser] = await Promise.all([
            this.userService.getUser(playerOneId),
            this.userService.getUser(playerTwoId),
        ]);

        const match = {
            id: `mm:match:${mode}:${Date.now()}`,
            createdAt: Date.now(),
            mode,
            players: [
                this.mapUserToPlayer(firstUser, 0),
                this.mapUserToPlayer(secondUser, 1),
            ],
            status: "waiting_for_game_server",
        };

        await this.persistUserMatchLinks(match.players, match.id);
        await this.gameServerService.saveMatch(match);

        return match;
    }

    async createPveMatch(user) {
        const userUnits = await this.userService.getUserUnits(user.userId);
        const botUnits = this.createBotUnits(userUnits);
        const botId = `bot:${user.userId}`;

        const match = {
            id: `mm:match:${MATCH_MODES.PVE}:${Date.now()}`,
            createdAt: Date.now(),
            mode: MATCH_MODES.PVE,
            players: [
                this.mapUserToPlayer(user, 0),
                {
                    userId: botId,
                    username: "Arena Bot",
                    rating: user.rating,
                    level: user.level,
                    teamId: 1,
                    isBot: true,
                    units: botUnits,
                },
            ],
            status: "waiting_for_game_server",
        };

        await this.persistUserMatchLinks([match.players[0]], match.id);
        await this.gameServerService.saveMatch(match);

        return match;
    }

    createBotUnits(userUnits) {
        return userUnits.map(unit => ({
            ...unit,
            InstanceId: `${unit.InstanceId}_bot`,
            Name: `${unit.Name} Bot`,
        }));
    }

    mapUserToPlayer(user, teamId) {
        if (!user) {
            throw new Error("Match player cannot be created without user data");
        }

        return {
            userId: user.userId,
            username: user.username,
            rating: user.rating,
            level: user.level,
            teamId,
        };
    }

    async persistUserMatchLinks(players, matchId) {
        await Promise.all(players.map(player =>
            this.mmRedis.set(this.getUserMatchKey(player.userId), matchId, { EX: 300 })
        ));
    }

    async dequeueUser(userId, mode) {
        if (mode) {
            return this.dequeueFromMode(userId, this.normalizeMode(mode));
        }

        const results = await Promise.all(
            Object.values(MATCH_MODES).map(queueMode => this.dequeueFromMode(userId, queueMode))
        );

        return {
            status: "dequeued",
            removedFromQueue: results.some(result => result.removedFromQueue),
        };
    }

    async dequeueFromMode(userId, mode) {
        let removedFromQueue = false;

        await this.mmRedis.del(this.getQueueMetaKey(mode, userId));

        if (mode === MATCH_MODES.PVP) {
            const removed = await this.mmRedis.zRem(this.getQueueKey(mode), userId);
            removedFromQueue = removed > 0;
        }

        const pendingKey = await this.mmRedis.get(this.getPendingUserKey(mode, userId));
        if (pendingKey) {
            const pendingRaw = await this.mmRedis.get(pendingKey);

            if (pendingRaw) {
                const pending = JSON.parse(pendingRaw);
                const opponentId = pending.p1 === userId ? pending.p2 : pending.p1;
                await this.mmRedis.del(this.getPendingUserKey(mode, opponentId));
            }

            await this.mmRedis.del(pendingKey);
            await this.mmRedis.del(this.getPendingUserKey(mode, userId));
        }

        await this.mmRedis.del(this.getUserMatchKey(userId));

        return {
            status: "dequeued",
            mode,
            removedFromQueue,
        };
    }
}

module.exports = MatchmakingService;
