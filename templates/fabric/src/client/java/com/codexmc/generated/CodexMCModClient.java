package com.codexmc.generated;

import net.fabricmc.api.ClientModInitializer;

public class CodexMCModClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        CodexMCMod.LOGGER.info("CodexMC client setup.");
    }
}
