class UserService {
    constructor(usersRedis) {
        this.usersRedis = usersRedis;
    }

    async getUser(userId) {
        const raw = await this.usersRedis.get(`user:${userId}`);
        return raw ? JSON.parse(raw) : null;
    }

    async getUserUnits(userId) {
        const user = await this.getUser(userId);

        if (!user) {
            throw new Error(`User ${userId} not found`);
        }

        if (!Array.isArray(user.equipmentHeroes)) {
            throw new Error(`User ${userId} has no equipmentHeroes`);
        }

        console.log("Units loaded", {
            userId,
            count: user.equipmentHeroes.length,
        });

        return user.equipmentHeroes;
    }
}

module.exports = UserService;
