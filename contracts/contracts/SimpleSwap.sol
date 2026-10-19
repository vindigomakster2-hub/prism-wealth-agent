// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IPriceOracle} from "./Interfaces.sol";

/// @notice Oracle-priced swap venue with a flat fee. Stands in for a DEX aggregator on the local chain.
contract SimpleSwap {
    IPriceOracle public immutable oracle;
    uint256 public constant FEE_BPS = 30;

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address _oracle) {
        oracle = IPriceOracle(_oracle);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 usd6 = oracle.valueUsd6(tokenIn, amountIn);
        return (oracle.amountForUsd6(tokenOut, usd6) * (10_000 - FEE_BPS)) / 10_000;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external returns (uint256 out) {
        require(tokenIn != tokenOut, "same token");
        out = quote(tokenIn, tokenOut, amountIn);
        require(out >= minAmountOut, "slippage");
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "transfer in failed");
        require(IERC20(tokenOut).transfer(msg.sender, out), "insufficient liquidity");
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, out);
    }
}
