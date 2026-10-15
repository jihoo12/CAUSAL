{
  description = "CAUSAL TypeScript development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: {
    devShells = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ] (system: {
      default = let pkgs = import nixpkgs { inherit system; }; in pkgs.mkShellNoCC {
        packages = [ pkgs.nodejs_24 pkgs.pnpm ];
      };
    });
  };
}
