package com.codexmc.generated;

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class CodexMCMod implements ModInitializer {
    public static final String MOD_ID = "codexmc_mod";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        LOGGER.info("CodexMC generated mod initialized.");
    }
}
