// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./Interfaces.sol";

/// @title TBillVault
/// @notice Stand-in for a tokenized T-bill fund: USDC in, fixed APR accrues via a share index.
///         Yield is paid from a reserve funded at deploy time. Withdrawals always go to msg.sender.
contract TBillVault {
    IERC20 public immutable asset;
    uint256 public immutable aprBps;
    uint256 public index = 1e18;
    uint64 public lastUpdate;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);

    constructor(address _asset, uint256 _aprBps) {
        asset = IERC20(_asset);
        aprBps = _aprBps;
        lastUpdate = uint64(block.timestamp);
    }

    function currentIndex() public view returns (uint256) {
        return index + (index * aprBps * (block.timestamp - lastUpdate)) / (10_000 * 365 days);
    }

    function balanceOfAssets(address user) external view returns (uint256) {
        return (sharesOf[user] * currentIndex()) / 1e18;
    }

    function totalAssets() external view returns (uint256) {
        return (totalShares * currentIndex()) / 1e18;
    }

    function deposit(uint256 amount) external returns (uint256 shares) {
        require(amount > 0, "zero amount");
        _update();
        shares = (amount * 1e18) / index;
        require(asset.transferFrom(msg.sender, address(this), amount), "transfer failed");
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, amount, shares);
    }

    function withdraw(uint256 amount) external returns (uint256 shares) {
        _update();
        shares = (amount * 1e18 + index - 1) / index;
        require(sharesOf[msg.sender] >= shares, "insufficient balance");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        require(asset.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount, shares);
    }

    function withdrawAll() external returns (uint256 amount) {
        _update();
        uint256 shares = sharesOf[msg.sender];
        require(shares > 0, "nothing to withdraw");
        amount = (shares * index) / 1e18;
        sharesOf[msg.sender] = 0;
        totalShares -= shares;
        require(asset.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount, shares);
    }

    function _update() internal {
        index = currentIndex();
        lastUpdate = uint64(block.timestamp);
    }
}
