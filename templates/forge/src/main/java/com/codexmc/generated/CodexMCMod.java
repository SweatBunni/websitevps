package com.codexmc.generated;

import net.minecraftforge.fml.common.Mod;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(CodexMCMod.MOD_ID)
public class CodexMCMod {
    public static final String MOD_ID = "codexmc_mod";
    public static final Logger LOGGER = LogManager.getLogger();

    public CodexMCMod() {
        LOGGER.info("CodexMC Forge mod initialized.");
    }
}
