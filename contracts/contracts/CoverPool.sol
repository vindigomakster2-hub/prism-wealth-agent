// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, ILiquidationSource} from "./Interfaces.sol";

/// @title CoverPool
/// @notice Parametric liquidation cover: pays the liquidation penalty a holder suffers in the lending pool
///         after buying the policy, up to the covered amount. Claims are verified on-chain, no adjuster.
contract CoverPool {
    IERC20 public immutable usdc;
    ILiquidationSource public immutable lendingPool;
    uint256 public premiumRateBps = 400; // 4% of cover per year
    uint256 public constant MAX_DURATION_DAYS = 365;
    uint256 public constant CLAIM_GRACE = 7 days;

    struct Policy {
        address holder;
        uint256 coverUsd6;
        uint256 premiumUsd6;
        uint64 start;
        uint64 expiry;
        uint256 penaltySnapshot;
        bool claimed;
    }

    Policy[] public policies;
    mapping(address => uint256[]) internal _policiesOf;

    event CoverPurchased(uint256 indexed id, address indexed holder, uint256 coverUsd6, uint256 premiumUsd6, uint64 expiry);
    event CoverClaimed(uint256 indexed id, address indexed holder, uint256 payoutUsd6);

    constructor(address _usdc, address _lendingPool) {
        usdc = IERC20(_usdc);
        lendingPool = ILiquidationSource(_lendingPool);
    }

    function quote(uint256 coverUsd6, uint256 durationDays) public view returns (uint256) {
        return (coverUsd6 * premiumRateBps * durationDays) / (10_000 * 365);
    }

    function buyCover(uint256 coverUsd6, uint256 durationDays) external returns (uint256 id) {
        require(coverUsd6 > 0, "zero cover");
        require(durationDays > 0 && durationDays <= MAX_DURATION_DAYS, "bad duration");
        uint256 premium = quote(coverUsd6, durationDays);
        require(usdc.transferFrom(msg.sender, address(this), premium), "premium transfer failed");
        id = policies.length;
        uint64 expiry = uint64(block.timestamp + durationDays * 1 days);
        policies.push(
            Policy(msg.sender, coverUsd6, premium, uint64(block.timestamp), expiry, lendingPool.liquidationPenaltyUsd6(msg.sender), false)
        );
        _policiesOf[msg.sender].push(id);
        emit CoverPurchased(id, msg.sender, coverUsd6, premium, expiry);
    }

    function claimable(uint256 id) public view returns (uint256) {
        Policy storage p = policies[id];
        if (p.claimed || block.timestamp > p.expiry + CLAIM_GRACE) return 0;
        uint256 loss = lendingPool.liquidationPenaltyUsd6(p.holder) - p.penaltySnapshot;
        return loss < p.coverUsd6 ? loss : p.coverUsd6;
    }

    function claim(uint256 id) external returns (uint256 payout) {
        Policy storage p = policies[id];
        require(p.holder == msg.sender, "not holder");
        payout = claimable(id);
        require(payout > 0, "nothing to claim");
        p.claimed = true;
        require(usdc.transfer(msg.sender, payout), "payout failed");
        emit CoverClaimed(id, msg.sender, payout);
    }

    function policiesOf(address holder) external view returns (uint256[] memory) {
        return _policiesOf[holder];
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }
}
