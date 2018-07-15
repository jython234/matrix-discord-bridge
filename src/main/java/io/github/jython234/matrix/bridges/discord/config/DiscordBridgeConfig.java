package io.github.jython234.matrix.bridges.discord.config;

/**
 * Represents the bridge configuration for discord.
 *
 * @author jython234
 */
public class DiscordBridgeConfig {
    Discord discord;

    DiscordBridgeConfig() {
        this.discord = new Discord();
    }

    public static class Discord {
        /**
         * Discord bot token.
         */
        String token;

        /**
         * Discord bot username.
         */
        String clientId;

        public String getToken() {
            return token;
        }

        public String getClientId() {
            return clientId;
        }
    }

    public Discord getDiscord() {
        return discord;
    }
}
