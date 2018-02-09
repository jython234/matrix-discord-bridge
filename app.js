const Discord = require("discord.js");
const YAML = require("yamljs");
const uuidv1 = require("uuid/v1");

const os = require("os");
const fs = require("fs");
const path = require("path");
const process = require("process");

const misc = require("./misc");
const matrixModule = require("./matrix");
// Config and functions -----------------------------------------------------------------------------------------------------------------
const defaultConfig = {
    initalSyncAvatars: true,
    discord: {
        token: "",
    },
    matrix: {
        serverURL: "https://matrix.org",
        domain: "matrix.org",
        bridgeAccount: {
            userId: "@example:matrix.org",
            password: "password"
        }
    },
    mappings: [
        {
            discordGuild: "",
            discordChannel: "",
            matrixRoom: ""
        }
    ]
};
var config;
var tempDir = path.join(os.tmpdir(), "matrix-discord-bridge");


// Program Main ----------------------------------------------------------------------------------------------------------------------------


try {
    fs.mkdirSync(tempDir);
} catch(e) {
    // Already exists
}

try {
    config = YAML.load("bridgeConfiguration.yml");
} catch(e) {
    console.error("Could not load bridgeConfiguration.yml, perhaps it doesn't exist? Creating it...");
    fs.writeFileSync("bridgeConfiguration.yml", YAML.stringify(defaultConfig, 4));
    console.error("Configuration file created. Please fill out the fields and then run the program again.")
    process.exit(1);
}

// Create maps of matrix and discord channel and room corralations for easier and faster lookups.
let matrixMappings = new Map();
let discordMappings = new Map();
let guildMappings = new Map();

for(let i = 0; i < config.mappings.length; i++) {
    matrixMappings.set(config.mappings[i].matrixRoom, {guild: config.mappings[i].discordGuild, channel: config.mappings[i].discordChannel});
    discordMappings.set(config.mappings[i].discordChannel, config.mappings[i].matrixRoom);

    if(guildMappings.has(config.mappings[i].discordGuild)) {
        let guild = guildMappings.get(config.mappings[i].discordGuild);
        guild.push(config.mappings[i].discordChannel);
        guildMappings.set(config.mappings[i].discordGuild, guild);
    } else {
        guildMappings.set(config.mappings[i].discordGuild, [config.mappings[i].discordChannel]);
    }
}

const discordClient = new Discord.Client();
const Cli = require("matrix-appservice-bridge").Cli;
const Bridge = require("matrix-appservice-bridge").Bridge;
const AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
const localPart = "_discordBridgeService";
var bridge;
var botId;

let typingMappings = new Map();

discordClient.on("ready", () => {
    let iterator = matrixMappings.keys();
    let users = [];
    // Loop through each matrix room and get discord infromation
    for(let i = 0; i < matrixMappings.size; i++) {
        let room = iterator.next().value;

        bridge.getIntent().invite(room, config.matrix.bridgeAccount.userId);
        matrixModule.sendMessage(room, "**Connected to Discord**");

        let channel = discordClient.guilds.get(matrixMappings.get(room).guild).channels.get(matrixMappings.get(room).channel);
        let iteratorMembers = channel.members.keys();
        // Loop through every member in the channel and make sure they're joined to the matrix room, and their presence and profile pictures are set
        for(let i2 = 0; i2 < channel.members.size; i2++) {
            let member = channel.members.get(iteratorMembers.next().value);
            let memberIntent = bridge.getIntent("@discord_"+member.user.username+":"+config.matrix.domain);

            memberIntent.join(room).then(() => {
                if(member.nickname != null) {
                    memberIntent.setDisplayName(member.nickname);
                }
            });

            if(users.includes(member.user.username)) {
                continue;
            } else users.push(member.user.username);

            // Check and set presence
            let matrixPresence;
            switch(member.presence.status) {
                case "online":
                    matrixPresence = "online";
                    break;
                case "offline":
                    matrixPresence = "offline";
                    break;
                case "idle":
                case "dnd":
                default:
                    matrixPresence = "unavailable";
                    break;
            }
            console.log("set " + member.user.username + " to " + matrixPresence);
            memberIntent.getClient().setPresence(matrixPresence);

            if(!config.initalSyncAvatars) continue;

            // Set avatars
            let url = member.user.avatarURL;
            if(url != null && url != "") {
                let filename = uuidv1() + ".png";
                misc.download(url, filename, (mimetype, downloadedLocation) => {
                    matrixModule.uploadContent(fs.createReadStream(downloadedLocation), filename, mimetype, bridge.getIntent().getClient()).then((url) => {
                        fs.unlinkSync(downloadedLocation);
                        memberIntent.setAvatarUrl(url);
                    });
                });
            }
        }
    }
});

discordClient.on("message", message => {
    if(message.author.username === config.discord.username) return;
    if((message.content == null || message.content == "") && message.attachments.size == 0) return;
    if(!discordMappings.has(message.channel.id)) return;

    let room = discordMappings.get(message.channel.id);
    let intent = bridge.getIntent("@discord_"+message.author.username+":"+config.matrix.domain)
    let author = message.member.nickname == null ? message.author.username : message.member.nickname;

    if(message.attachments.size > 0) {
        let attachment = message.attachments.values().next().value;
        misc.download(attachment.url, attachment.filename, (mimetype, downloadedLocation) => {
            matrixModule.uploadContent(fs.createReadStream(downloadedLocation), attachment.filename, mimetype, bridge.getIntent().getClient()).then((url) => {
                intent.sendMessage(room, misc.getFileOrImageUploadContent(attachment, url, mimetype)).done(() => fs.unlinkSync(downloadedLocation));
            }).catch((err) => {
                console.error("Failed to upload content!");
                console.error(err);
                bridge.getIntent().sendMessage(room, misc.getTextMessageFormatted("BOT ERROR: failed to send message"));
            });
        });
    } else {
        intent.setDisplayName(author).then(() => {
            intent.sendMessage(room, misc.getTextMessageFormatted(message.cleanContent));
        });
    }
});

discordClient.on("typingStart", (channel, user) => {
    if(user.username == config.discord.username) return;
    if(!discordMappings.has(channel.id)) return;

    bridge.getIntent("@discord_"+user.username+":"+config.matrix.domain).sendTyping(discordMappings.get(channel.id), true);
});

discordClient.on("typingStop", (channel, user) => {
    if(user.username == config.discord.username) return;
    if(!discordMappings.has(channel.id)) return;

    bridge.getIntent("@discord_"+user.username+":"+config.matrix.domain).sendTyping(discordMappings.get(channel.id), false);
});

discordClient.on("presenceUpdate", (oldMember, newMember) => {
    if(!guildMappings.has(newMember.guild.id)) return;

    let author = oldMember.nickname == null ? oldMember.user.username : oldMember.nickname;
    let intent = bridge.getIntent("@discord_"+oldMember.user.username+":"+config.matrix.domain);

    // Get the list of all matrix rooms this person is in
    let allRooms = [];
    let channels = guildMappings.get(oldMember.guild.id);
    console.log(channels);
    for(let i = 0; i < channels.length; i++) {
        if(newMember.permissionsIn(channels[i]).has(Discord.Permissions.FLAGS.VIEW_CHANNEL)) {
            console.log(discordMappings.get(channels[i]));
            allRooms.push(discordMappings.get(channels[i]));
        }
    }

    console.log(allRooms);

    if(oldMember.presence.status !== newMember.presence.status) {
        if(newMember.presence.status == "dnd" || newMember.presence.status == "idle") {
            misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Is now **" + (newMember.presence.status == "dnd" ? "on Do Not Disturb" : newMember.presence.status) + "**"));
            intent.getClient().setPresence("offline");
        } else {
            intent.getClient().setPresence(newMember.presence.status == "online" ? "online" : "offline");
        }
    }

    if(oldMember.presence.game == null && newMember.presence.game != null) {
        if(newMember.presence.game.type == 2) {
            misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Is now listening to ***" + newMember.presence.game.name + "***"));
        } else {
            if(newMember.presence.game.streaming) {
                misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Is now playing ***" + newMember.presence.game.name + "*** and **streaming at:** " + newMember.presence.game.url));
            } else {
                misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Is now playing ***" + newMember.presence.game.name + "***"));
            }
        }
    }

    if(oldMember.presence.game != null && newMember.presence.game == null) {
        let listening = oldMember.presence.game.type == 2;
        misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Has " + (listening ? "stopped listening to" : "stopped playing") + " ***" + oldMember.presence.game.name + "***"));
    }

    if(oldMember.presence.game != null && newMember.presence.game != null) {
        if(oldMember.presence.game.streaming && !newMember.presence.game.streaming) {
            misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Has **stopped streaming**"));
        } else if(!oldMember.presence.game.streaming && newMember.presence.game.streaming){
            misc.intentSendMessageToRooms(intent, allRooms, misc.getNoticeFormatted("Has **started streaming at:** " + newMember.presence.game.url));
        }
    }
});

discordClient.on("channelPinsUpdate", (channel, time) => {
    if(!discordMappings.has(channel.id)) return;
    matrixModule.sendMessage(discordMappings.get(channel.id), "**Someone** ***pinned/unpinned a new message in the channel.***");
});

discordClient.on("guildMemberAdd", (member) => {
    if(!guildMappings.has(member.guild.id)) return;

    let author = member.nickname == null ? member.user.username : member.nickname;
    let intent = bridge.getIntent("@discord_"+member.user.username+":"+config.matrix.domain);

    // Get the list of all matrix rooms this person is in
    let allRooms = misc.getMatrixRoomsForMember(Discord, member, discordMappings, guildMappings);

    for(let i = 0; i < allRooms.length; i++) {
        bridge.getIntent().invite(allRooms[i], "@discord_"+member.user.username+":"+config.matrix.domain).then(() => {
            intent.join(allRooms[i]).then(() =>  {
            intent.setDisplayName(author).then(() => {
                    let url = member.user.avatarURL;
                    if(url != null && url != "") {
                        let filename = uuidv1() + ".png";
                        misc.download(url, filename, (mimetype, downloadedLocation) => {
                            matrixModule.uploadContent(fs.createReadStream(downloadedLocation), filename, mimetype, bridge.getIntent().getClient()).then((url) => {
                                fs.unlinkSync(downloadedLocation);
                                intent.setAvatarUrl(url);
                            });
                        });
                    }
                });
            });
        });
    }
});

discordClient.on("guildMemberRemove", (member) => {
    if(!guildMappings.has(member.guild.id)) return;

    let intent = bridge.getIntent("@discord_"+member.user.username+":"+config.matrix.domain);

    // Get the list of all matrix rooms this person is in
    let allRooms = misc.getMatrixRoomsForMember(Discord, member, discordMappings, guildMappings);

    for(let i = 0; i < allRooms.length; i++) {
        intent.leave(allRooms[i]);
    }
});

discordClient.on("guildMemberUpdate", (oldMember, newMember) => {
    if(!guildMappings.has(newMember.guild.id)) return;

    let intent = bridge.getIntent("@discord_"+oldMember.user.username+":"+config.matrix.domain);

    // Get the list of all matrix rooms this person is in
    //let allRooms = misc.getMatrixRoomsForMember(Discord, newMember, discordMappings, guildMappings);

    if(oldMember.nickname !== newMember.nickname) {
        intent.setDisplayName(newMember.nickname);
    }
});

discordClient.on("userUpdate", (oldUser, newUser) => {
    if(oldUser.avatar !== newUser.avatar) {
        let url = newUser.avatarURL;
        let intent = bridge.getIntent("@discord_"+oldUser.username+":"+config.matrix.domain);
        if(url != null && url != "") {
            let filename = uuidv1() + ".png";
            misc.download(url, filename, (mimetype, downloadedLocation) => {
                matrixModule.uploadContent(fs.createReadStream(downloadedLocation), filename, mimetype, bridge.getIntent().getClient()).then((url) => {
                    fs.unlinkSync(downloadedLocation);
                    intent.setAvatarUrl(url);
                });
            });
        }
    }
});

// Handle typing from matrix side
matrixModule.doBridgeAccount(config, matrixMappings, (room) => {
    // Check if we are bridging that room
    if(!matrixMappings.has(room)) return;

    let channel = discordClient.guilds.get(matrixMappings.get(room).guild).channels.get(matrixMappings.get(room).channel);

    if(typingMappings.has(room)) {
        let prev = typingMappings.get(room);
        prev = prev + 1;

        if(prev == 1) {
            channel.startTyping();
        }

        typingMappings.set(room, prev);

    } else {
        typingMappings.set(room, 1);
        channel.startTyping();
    }
}, (room) => {
    // Check if we are bridging that room
    if(!matrixMappings.has(room)) return;

    console.log("Typing stop detected");

    let channel = discordClient.guilds.get(matrixMappings.get(room).guild).channels.get(matrixMappings.get(room).channel);

    if(typingMappings.has(room)) {
        let prev = typingMappings.get(room);
        prev = prev - 1;
        if(prev <= 0) {
            prev = 0;
            channel.stopTyping();
        }

        typingMappings.set(room, prev);
    }
});

new Cli({
    registrationPath: "discord-bridge-registration.yml",
    generateRegistration: function(reg, callback) {
        reg.setId(AppServiceRegistration.generateToken());
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart(localPart);
        reg.addRegexPattern("users", "@discord_.*", true);
        callback(reg);
    },
    run: function(port, cfg) {
        bridge = new Bridge({
            homeserverUrl: config.matrix.serverURL,
            domain: config.matrix.domain,
            registration: "discord-bridge-registration.yml",

            controller: {
                onUserQuery: function(queriedUser) {
                    return {}; // auto-provision users with no additonal data
                },

                onEvent: function(request, context) {
                    let event = request.getData();

                    console.log(event.type);
                    switch(event.type) {
                        case "m.room.member":
                            if(event.content.membership == "invite" && event.state_key == "@" + localPart + ":" + config.matrix.domain) {
                                // Check if the room is found in our mappings
                                if(matrixMappings.has(event.room_id)) {
                                    // Room is in mappings, join ourselves and then the Bridge Service account
                                    bridge.getIntent().join(event.room_id).then(() => {
                                        bridge.getIntent().invite(event.room_id, config.matrix.bridgeAccount.userId);
                                    });
                                }
                            }

                            // TODO: process other events
                            break;
                        case "m.room.message":
                            if(event.age >= 5000) return;
                            if(event.sender == config.matrix.bridgeAccount.userId) return;

                            let channel = discordClient.guilds.get(matrixMappings.get(event.room_id).guild).channels.get(matrixMappings.get(event.room_id).channel);
                            let isFile = false;
                            switch(event.content.msgtype) {
                                case "m.text":
                                    channel.send("**" + event.sender + "**: " + event.content.body);
                                    break;
                                case "m.file":
                                    isFile = true;
                                case "m.image":
                                    // Check if file size is greater than 8 MB, discord does not allow files greater than 8 MB
                                    if(event.content.info.size >= (1024*1024*8)) {
                                        // File is too big, send link then
                                        channel.send("**" + event.sender + "**: ***Sent " + (isFile ? "a file" : "an image") + ":*** " + config.matrix.serverURL + "/_matrix/media/v1/download/" + event.content.url.replace("mxc://", ""));
                                    } else {
                                        misc.downloadFromMatrix(config, event.content.url.replace("mxc://", ""), event.content.body, (mimeType, downloadedLocation) => {
                                            channel.send("**" + event.sender + "**: ***Sent " + (isFile ? "a file" : "an image") + ":*** " + event.content.body + "*", new Discord.Attachment(downloadedLocation, event.content.body))
                                                .then(() => fs.unlinkSync(downloadedLocation));
                                                // Delete the image we downloaded after we uploaded it
                                        });
                                    }
                                    break;
                            }
                            break;
                    }
                }
            }
        });
        console.log("Matrix appservice listening on port %s", port);
        bridge.run(port, config);
    }
}).run();

discordClient.login(config.discord.token);
