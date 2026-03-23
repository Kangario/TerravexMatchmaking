const crypto = require("node:crypto");
const {
    FIELD_WIDTH,
    FIELD_HEIGHT,
    TEAM_SPAWN_MARGIN,
} = require("../config/constants");

class GameServerService {
    constructor(gsRedis, userService) {
        this.gsRedis = gsRedis;
        this.userService = userService;
    }

    async saveMatch(match) {
        const key = `gs:match:${match.id}`;
        const unitsByPlayer = [];

        for (const player of match.players) {
            const heroes = await this.getHeroesForPlayer(player);
            unitsByPlayer.push(...this.normalizeHeroes(heroes, player.userId, player.teamId));
        }

        const gsMatch = {
            id: match.id,
            createdAt: match.createdAt,
            mode: match.mode,
            players: match.players,
            status: "waiting_for_server",
            seed: crypto.randomInt(0, 2 ** 31),
            units: unitsByPlayer,
        };

        await this.gsRedis.set(key, JSON.stringify(gsMatch), { EX: 3600 });
        await this.gsRedis.lPush("gs:queue:matches", match.id);

        console.log("Match saved to GS", {
            matchId: match.id,
            mode: match.mode,
            seed: gsMatch.seed,
            unitsCount: unitsByPlayer.length,
            players: match.players.map(player => player.userId),
        });
    }

    async getMatch(matchId) {
        const raw = await this.gsRedis.get(`gs:match:${matchId}`);
        return raw ? JSON.parse(raw) : null;
    }

    async getHeroesForPlayer(player) {
        if (Array.isArray(player.units)) {
            return player.units;
        }

        return this.userService.getUserUnits(player.userId);
    }

    getRandomPositionByTeam(teamId) {
        const minY = teamId === 0 ? 1 : FIELD_HEIGHT - 2;
        const maxY = minY;

        return {
            x: this.getRandomInt(TEAM_SPAWN_MARGIN, FIELD_WIDTH - TEAM_SPAWN_MARGIN),
            y: this.getRandomInt(minY, maxY),
        };
    }

    getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    normalizeHeroes(equipmentHeroes, ownerId, teamId) {
        const usedPositions = new Set();

        return equipmentHeroes.map((hero, index) => {
            let position;

            do {
                position = this.getRandomPositionByTeam(teamId);
            } while (usedPositions.has(`${position.x}_${position.y}`));

            usedPositions.add(`${position.x}_${position.y}`);

            return {
                id: `${ownerId}_${index}`,
                team: teamId,
                heroId: hero.Id,
                templateId: hero.InstanceId,
                playerId: ownerId,
                name: hero.Name,
                gender: hero.Gender,
                hp: hero.HpMax,
                maxHp: hero.HpMax,
                ap: hero.MaxAP,
                initiative: hero.Initiative,
                damageP: hero.DamageP,
                damageM: hero.DamageM,
                defenceP: hero.DefenceP,
                defenceM: hero.DefenceM,
                attackRange: hero.AttackRange,
                moveCost: hero.MoveCost,
                level: hero.Lvl,
                skills: hero.Skills,
                equipmentSlots: hero.EquipmentSlots,
                position,
            };
        });
    }
}

module.exports = GameServerService;
