package com.codexmc.generated;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(CodexMCMod.MOD_ID)
public class CodexMCMod {
    public static final String MOD_ID = "codexmc_mod";
    public static final Logger LOGGER = LogManager.getLogger();

    public CodexMCMod(IEventBus modEventBus, ModContainer modContainer) {
        LOGGER.info("CodexMC NeoForge mod initialized.");
    }
}
