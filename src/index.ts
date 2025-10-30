// src/index.ts

// Define environment bindings
interface Env {
    // Static assets
    ASSETS: any;
}

// Worker entrypoint
export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        // Just serve the static UI
        console.log("welcome to biblical art explorer")
        console.log("rowan williams has funny eyebrows")
        return env.ASSETS.fetch(request);
    },
};
