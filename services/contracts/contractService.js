const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const contractStore = require('./contractStore');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min is plenty of resolution for a 24h window

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

async function grantContract(client, contract) {
    const guild = await client.guilds.fetch(contract.guildId).catch(() => null);
    if (!guild) return;

    const member = await guild.members.fetch(contract.toUserId).catch(() => null);
    if (!member) return;

    // Remove any other team role they held before, WITHIN THE SAME LEAGUE
    // only — someone competing in two leagues at once (e.g. UL and HL)
    // must keep their team role in the other league untouched.
    const config = loadConfig();
    const sameLeagueTeamRoleIds = Object.entries(config.roles_equipos)
        .filter(([, info]) => info.categoria === contract.categoria)
        .map(([roleId]) => roleId);

    const rolesToRemove = sameLeagueTeamRoleIds.filter(id => id !== contract.teamRoleId && member.roles.cache.has(id));
    if (rolesToRemove.length) {
        await member.roles.remove(rolesToRemove).catch(err => console.error('❌ [Contracts] Error removing old roles:', err.message));
    }

    await member.roles.add(contract.teamRoleId).catch(err => console.error('❌ [Contracts] Error adding team role:', err.message));
    await member.roles.add(contract.ligaRoleId).catch(err => console.error('❌ [Contracts] Error adding league role:', err.message));

    contractStore.updateContract(contract.id, c => { c.granted = true; c.status = 'completed'; });

    // DM the player directly...
    member.send(`🏁 Congratulations! You've been officially assigned to **${contract.teamName}** (${contract.categoria}) as **${contract.seatLabel || 'driver'}**.`).catch(() => { });

    // ...and also post publicly in the original channel, so everyone can see it went through.
    const channel = await guild.channels.fetch(contract.channelId).catch(() => null);
    if (channel) {
        const teamInfo = config.roles_equipos[contract.teamRoleId];
        const teamColor = teamInfo?.color || '#2ecc71';

        const embed = new EmbedBuilder()
            .setColor(teamColor)
            .setTitle('🏁 Contract confirmed')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(`${member} has officially joined **${contract.teamName}** (${contract.categoria}) as **${contract.seatLabel || 'driver'}**. Team and league roles have been granted.`)
            .setFooter({ text: `Contract #${contract.id.slice(0, 8)}` })
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(() => { });
    }

    console.log(`✅ [Contracts] Roles granted to ${member.user.tag} for ${contract.teamName}.`);
}

function startContractLoop(client) {
    const check = async () => {
        const all = contractStore.allContracts();
        const now = Date.now();
        for (const contract of Object.values(all)) {
            if (contract.status === 'accepted' && !contract.granted && contract.grantAt && now >= contract.grantAt) {
                await grantContract(client, contract);
            }
        }
    };
    check();
    setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { startContractLoop };